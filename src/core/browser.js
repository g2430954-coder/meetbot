const puppeteer = require('puppeteer-core');
const { exec, spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const fs = require('fs-extra');

let browser = null;
let page = null;
let tunnelInstance = null;
let tunnelUrl = null;
let activeParticipantName = null;
let antiKickInterval = null;

// Pool of authentic, natural-sounding human names to prevent bot flagging or host kicks
const REALISTIC_HUMAN_NAMES = [
    "Rahul Sharma", "Aarav Verma", "Rohan Mehta", "Ananya Singh",
    "Sneha Patel", "Priya Nair", "Aditya Kapoor", "Saurabh Roy",
    "Neha Gupta", "Vikram Das", "Kavya Reddy", "Amitabh Joshi",
    "Divya Iyer", "Karan Malhotra", "Pooja Choudhury", "Arjun Bhatia",
    "Shreya Saxena", "Manish Pandey", "Rishi Agarwal", "Isha Deshmukh",
    "Tarun Banerji", "Meera Pillai", "Nikhil Kulkarni", "Swati Rao",
    "Varun Shah", "Alok Sengupta", "Nisha Thakur", "Deepak Saxena",
    "Sunita Chawla", "Harsh Vardhan", "Ritu Shrivastava", "Abhishek Tiwari",
    "Simran Gill", "Gaurav Chopra", "Akansha Mishra", "Vijay Kumar",
    "Ritu Rajput", "Rajesh Khanna", "Siddharth Jain", "Tanvi Kulkarni",
    "Prateek Yadav", "Srishti Basu", "Mayank Jain", "Ankita Sen",
    "Kunal Roy", "Preeti Soni", "Yash Wardhan"
];

function getRandomHumanName() {
    const idx = Math.floor(Math.random() * REALISTIC_HUMAN_NAMES.length);
    return REALISTIC_HUMAN_NAMES[idx];
}

/**
 * Helper function to discover unpacked Chrome extensions, zipped extensions (.zip / .crx)
 */
function getExtensionPaths() {
    const extensionPaths = [];
    const defaultExtensionsDir = path.join(__dirname, '../../extensions');
    fs.ensureDirSync(defaultExtensionsDir);

    // Auto extract any .zip or .crx extension files in extensions/
    try {
        const zipFiles = fs.readdirSync(defaultExtensionsDir).filter(f => f.endsWith('.zip') || f.endsWith('.crx'));
        for (const zipFile of zipFiles) {
            const zipPath = path.join(defaultExtensionsDir, zipFile);
            const targetDir = path.join(defaultExtensionsDir, path.basename(zipFile, path.extname(zipFile)));
            if (!fs.existsSync(targetDir)) {
                logger.info(`Auto-extracting Chrome Extension archive: ${zipFile}...`);
                try {
                    const { execSync } = require('child_process');
                    execSync(`unzip -o "${zipPath}" -d "${targetDir}" 2>/dev/null || true`);
                } catch (e) {}
            }
        }
    } catch (e) {}

    const checkAndAdd = (dirPath) => {
        if (!dirPath) return;
        const absPath = path.resolve(dirPath);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
            const manifestPath = path.join(absPath, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                if (!extensionPaths.includes(absPath)) {
                    extensionPaths.push(absPath);
                }
            } else {
                try {
                    const subitems = fs.readdirSync(absPath);
                    for (const sub of subitems) {
                        const subPath = path.join(absPath, sub);
                        if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
                            if (fs.existsSync(path.join(subPath, 'manifest.json'))) {
                                if (!extensionPaths.includes(subPath)) {
                                    extensionPaths.push(subPath);
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
        }
    };

    if (fs.existsSync(defaultExtensionsDir)) {
        try {
            const items = fs.readdirSync(defaultExtensionsDir);
            for (const item of items) {
                const itemPath = path.join(defaultExtensionsDir, item);
                checkAndAdd(itemPath);
            }
        } catch (e) {
            logger.warn(`Error reading extensions directory: ${e.message}`);
        }
    }

    const envExt = process.env.CHROME_EXTENSIONS || process.env.EXTENSION_PATH;
    if (envExt) {
        const customPaths = envExt.split(',').map(p => p.trim()).filter(Boolean);
        for (const p of customPaths) {
            checkAndAdd(p);
        }
    }

    return extensionPaths;
}

/**
 * Automates entering Google Meet pre-join screen, setting human name,
 * turning off mic/cam, and clicking Ask to join / Join now.
 */
async function joinGoogleMeet(page, customDisplayName) {
    const participantName = customDisplayName || process.env.BOT_DISPLAY_NAME || getRandomHumanName();
    activeParticipantName = participantName;
    logger.info(`Google Meet Stealth Human Joiner active. Using participant identity: "${participantName}"`);

    // 1. Initial wait for page DOM readiness
    await new Promise(r => setTimeout(r, 4000));

    // 2. Turn Off Mic (Ctrl+D) & Camera (Ctrl+E)
    try {
        logger.info("Muting Microphone (Ctrl+D) and Camera (Ctrl+E)...");
        await page.keyboard.down('Control');
        await page.keyboard.press('d');
        await page.keyboard.up('Control');
        await new Promise(r => setTimeout(r, 500));

        await page.keyboard.down('Control');
        await page.keyboard.press('e');
        await page.keyboard.up('Control');
        await new Promise(r => setTimeout(r, 500));
    } catch (e) {
        logger.warn(`Mic/Cam mute shortcut notice: ${e.message}`);
    }

    // Auto-dismiss initial popups if present ("Got it", "Dismiss", "Allow notifications")
    try {
        const buttons = await page.$$('button');
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent || '', btn);
            if (text.match(/got it|dismiss|allow/i)) {
                await btn.click().catch(() => {});
            }
        }
    } catch (e) {}

    // 3. Find and fill Display Name input field
    logger.info("Searching for Display Name input field...");
    let nameInput = null;
    const nameSelectors = [
        'input[type="text"][aria-label*="name" i]',
        'input[type="text"][placeholder*="name" i]',
        'input[type="text"][aria-label*="Your name" i]',
        'input[type="text"][placeholder*="Your name" i]',
        'input[name="name"]',
        'input[type="text"]'
    ];

    for (const selector of nameSelectors) {
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 3000 });
            nameInput = await page.$(selector);
            if (nameInput) {
                logger.info(`Found name input field using selector: ${selector}`);
                break;
            }
        } catch (e) {}
    }

    if (nameInput) {
        // Clear field cleanly
        await nameInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 300));

        // Human keypress simulation (50ms - 130ms delay between keys)
        for (const char of participantName) {
            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 50 });
        }
        logger.info(`Successfully entered human name: "${participantName}"`);
        await new Promise(r => setTimeout(r, 800));
    } else {
        logger.info("No name input field found (user logged in or direct entrance).");
    }

    // 4. Locate and click "Ask to join" or "Join now"
    logger.info("Searching for 'Ask to join' / 'Join now' button...");
    let joined = false;

    for (let attempt = 0; attempt < 10; attempt++) {
        // Try multiple detection methods in parallel
        const buttonHandles = await page.$x(
            '//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "ask to join") or ' +
            'contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "join now") or ' +
            'contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "rejoin") or ' +
            'contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "join")] | ' +
            '//span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "ask to join") or ' +
            'contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "join now")]/ancestor::button'
        );

        if (buttonHandles.length > 0) {
            for (const btn of buttonHandles) {
                const isVisibleAndEnabled = await page.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 &&
                           style.visibility !== 'hidden' &&
                           style.display !== 'none' &&
                           !el.disabled;
                }, btn);

                if (isVisibleAndEnabled) {
                    const btnText = await page.evaluate(el => el.textContent, btn);
                    logger.info(`Attempting to click Google Meet join button: "${btnText.trim()}"`);

                    // Use a more robust click method (JavaScript click as backup)
                    await btn.click().catch(async () => {
                        await page.evaluate(el => el.click(), btn);
                    });

                    joined = true;
                    break;
                }
            }
        }

        if (joined) {
            // Verify if we actually moved past the join screen
            await new Promise(r => setTimeout(r, 2000));
            const stillOnJoinScreen = await page.evaluate(() => {
                return !!document.querySelector('input[type="text"][aria-label*="name" i]') ||
                       document.body.innerText.includes("Ready to join?");
            });
            if (!stillOnJoinScreen) {
                logger.info("Successfully joined meeting / request sent.");
                break;
            } else {
                logger.info("Still on join screen, retrying click...");
                joined = false;
            }
        }

        // Backup check for Google Meet primary JSName button (Qx7uJf = Join Now, CQA6B = Ask to Join)
        try {
            const jsNameBtn = await page.$('button[jsname="Qx7uJf"], button[jsname="CQA6B"]');
            if (jsNameBtn) {
                const isDisabled = await page.evaluate(el => el.disabled, jsNameBtn);
                if (!isDisabled) {
                    logger.info("Clicking Google Meet primary action button via JSName...");
                    await jsNameBtn.click().catch(() => page.evaluate(el => el.click(), jsNameBtn));
                    joined = true;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        } catch (e) {}

        await new Promise(r => setTimeout(r, 1500));
    }

    if (!joined) {
        logger.warn("Join button not clicked automatically. Standing by on room page.");
    } else {
        logger.info("Join request submitted to Google Meet host successfully.");
    }

    // 5. Start Anti-Kick / Anti-Ban background observer
    startAntiKickWatcher(page);

    return participantName;
}

/**
 * Automates entering Zoom Web Client pre-join screen and entering meeting
 */
async function joinZoomMeeting(page, customDisplayName) {
    const participantName = customDisplayName || process.env.BOT_DISPLAY_NAME || getRandomHumanName();
    activeParticipantName = participantName;
    logger.info(`Zoom Stealth Human Joiner active. Using participant identity: "${participantName}"`);

    await new Promise(r => setTimeout(r, 4000));

    try {
        const buttons = await page.$$('button');
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent || '', btn);
            if (text.match(/accept|agree|dismiss|got it/i)) {
                await btn.click().catch(() => {});
            }
        }
    } catch (e) {}

    try {
        const nameSelector = 'input#inputname, input[name="inputname"], input[placeholder*="name" i], input[type="text"]';
        await page.waitForSelector(nameSelector, { visible: true, timeout: 8000 });
        const nameInput = await page.$(nameSelector);
        if (nameInput) {
            await nameInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            for (const char of participantName) {
                await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 50 });
            }
            logger.info(`Entered Zoom participant name: "${participantName}"`);
        }
    } catch (e) {
        logger.warn(`Zoom name input notice: ${e.message}`);
    }

    try {
        await new Promise(r => setTimeout(r, 1000));
        const joinBtnSelector = '#joinBtn, button.preview-join-button, button[type="submit"]';
        const joinBtn = await page.$(joinBtnSelector);
        if (joinBtn) {
            await joinBtn.click().catch(() => page.evaluate(el => el.click(), joinBtn));
            logger.info("Clicked Zoom Web Client Join button.");
        } else {
            const btnHandles = await page.$x('//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "join")]');
            if (btnHandles.length > 0) {
                await btnHandles[0].click().catch(() => page.evaluate(el => el.click(), btnHandles[0]));
            }
        }
    } catch (e) {}

    setTimeout(async () => {
        try {
            const audioBtn = await page.$('#join-audio-by-voip, button.join-audio-by-voip');
            if (audioBtn) {
                await audioBtn.click().catch(() => page.evaluate(el => el.click(), audioBtn));
                logger.info("Clicked Zoom 'Join Audio by Computer'");
            }
        } catch (e) {}
    }, 5000);

    return participantName;
}

function startAntiKickWatcher(page) {
    if (antiKickInterval) clearInterval(antiKickInterval);
    antiKickInterval = setInterval(async () => {
        try {
            if (!page || page.isClosed()) {
                if (antiKickInterval) clearInterval(antiKickInterval);
                return;
            }

            const isDenied = await page.evaluate(() => {
                const text = document.body ? document.body.innerText || '' : '';
                // Dismiss "Got it" or "Dismiss" popups inside call efficiently
                const buttons = document.querySelectorAll('button');
                for (let i = 0; i < buttons.length; i++) {
                    const btnText = (buttons[i].textContent || '').trim().toLowerCase();
                    if (btnText === 'got it' || btnText === 'dismiss') {
                        buttons[i].click();
                    }
                }
                return text.includes("Someone in the call denied your request") || text.includes("You can't join this call");
            }).catch(() => false);

            if (isDenied) {
                logger.warn("Join request denied by meeting host. Retrying automatically with fresh human identity...");
                const newName = getRandomHumanName();
                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                await joinGoogleMeet(page, newName).catch(() => {});
            }
        } catch (e) {}
    }, 15000);
}

/**
 * Initializes the virtual frame buffer and launches the meeting
 */
async function launchMeeting(url, customDisplayName = null) {
    try {
        logger.info("Connecting to pre-initialized Virtual Display & Visual Bridge...");

        process.env.DISPLAY = ':99';

        // 1. Setup Serveo Tunnel (Unlimited & No IP check)
        logger.info("Establishing Serveo Unlimited Tunnel...");
        try {
            // WAIT FOR LOCAL CONTROL BRIDGE (Port 6080) TO BE ACTIVE ON GITHUB RUNNER
            // This prevents the 502 Bad Gateway error.
            if (process.env.GITHUB_ACTIONS) {
                logger.info("GitHub Action detected: Waiting for Express Control Bridge to sync...");
                const axios = require('axios');
                let bridgeReady = false;
                for (let i = 0; i < 15; i++) {
                    try {
                        const res = await axios.get('http://127.0.0.1:6080/bridge_health', { timeout: 1000 });
                        if (res.data && res.data.status === 'active') {
                            bridgeReady = true;
                            break;
                        }
                    } catch (e) {}
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!bridgeReady) logger.warn("Express Control Bridge did not respond. Tunneling may fail with 502.");
            }

            // 1. Setup Tunnel (Serveo -> Pinggy -> LocalTunnel)
            tunnelInstance = spawn('ssh', ['-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=no', '-R', '80:localhost:6080', 'serveo.net'], {
                detached: false
            });

            tunnelUrl = await new Promise((resolve) => {
                let found = false;
                const timeout = setTimeout(() => {
                    if (!found) {
                        logger.warn("Serveo URL extraction timed out. Trying fallback tunnel...");
                        resolve(null);
                    }
                }, 15000);

                const handleOutput = (data) => {
                    const msg = data.toString();
                    logger.info(`[SERVEO DEBUG] ${msg}`);

                    const match = msg.match(/https:\/\/[a-z0-9.-]+\.(serveo\.net|serveousercontent\.com)/i);
                    if (match && !match[0].includes('console.serveo.net')) {
                        found = true;
                        clearTimeout(timeout);
                        resolve(match[0]);
                    }
                };

                tunnelInstance.stdout.on('data', handleOutput);
                tunnelInstance.stderr.on('data', handleOutput);

                tunnelInstance.on('error', (err) => {
                    logger.error(`Serveo Process Error: ${err.message}`);
                    resolve(null);
                });
            });

            // If Serveo failed or timed out, try Pinggy SSH tunnel
            if (!tunnelUrl || tunnelUrl.includes('localhost')) {
                logger.info("Attempting Pinggy Tunnel as fallback...");
                if (tunnelInstance) tunnelInstance.kill('SIGTERM');
                const pinggyUser = process.env.PINGGY_TOKEN ? `${process.env.PINGGY_TOKEN}+qr` : 'qr';
                tunnelInstance = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-p', '443', '-R', '0:localhost:6080', `${pinggyUser}@a.pinggy.io`], {
                    detached: false
                });
                tunnelUrl = await new Promise((resolve) => {
                    let found = false;
                    const pinggyTimeout = setTimeout(() => {
                        if (!found) resolve(null);
                    }, 12000);
                    const handlePinggy = (data) => {
                        const msg = data.toString();
                        logger.info(`[PINGGY DEBUG] ${msg}`);
                        const match = msg.match(/https:\/\/[a-z0-9.-]+\.pinggy\.(link|net)/i);
                        if (match) {
                            found = true;
                            clearTimeout(pinggyTimeout);
                            resolve(match[0]);
                        }
                    };
                    tunnelInstance.stdout.on('data', handlePinggy);
                    tunnelInstance.stderr.on('data', handlePinggy);
                    tunnelInstance.on('error', () => resolve(null));
                });
            }

            if (!tunnelUrl) {
                logger.warn("Public tunnel failed. Falling back to http://localhost:6080");
                tunnelUrl = "http://localhost:6080";
            } else {
                logger.info(`SUCCESS: Public VNC Tunnel established: ${tunnelUrl}`);
            }
        } catch (err) {
            logger.error(`Tunnel setup error: ${err.message}`);
            tunnelUrl = "http://localhost:6080";
        }

        const firefoxCandidatePaths = [
            process.env.FIREFOX_PATH,
            '/usr/bin/firefox',
            '/usr/bin/firefox-esr',
            '/snap/bin/firefox'
        ];

        const braveCandidatePaths = [
            process.env.BRAVE_PATH,
            '/usr/bin/brave-browser',
            '/usr/bin/brave',
            '/opt/brave.com/brave/brave-browser',
            '/snap/bin/brave'
        ];

        const chromeCandidatePaths = [
            process.env.CHROME_PATH,
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/opt/google/chrome/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium'
        ];

        let browserPath = null;
        const requestedBrowser = (process.env.BROWSER_TYPE || '').toLowerCase();

        if (requestedBrowser === 'firefox' || process.env.FIREFOX_PATH) {
            browserPath = firefoxCandidatePaths.find(p => p && fs.existsSync(p));
        } else if (requestedBrowser === 'brave' || process.env.BRAVE_PATH) {
            browserPath = braveCandidatePaths.find(p => p && fs.existsSync(p));
        }

        if (!browserPath) {
            const allCandidates = [
                ...chromeCandidatePaths,
                ...braveCandidatePaths,
                ...firefoxCandidatePaths
            ];
            browserPath = allCandidates.find(p => p && fs.existsSync(p)) || '/usr/bin/google-chrome-stable';
        }

        logger.info(`Using Browser binary: ${browserPath}`);

        const userDataDir = path.join(__dirname, '../../output/chrome_profile');
        fs.ensureDirSync(userDataDir);

        const extPaths = getExtensionPaths();
        const extensionFlags = [];
        if (extPaths.length > 0) {
            const joinedPaths = extPaths.join(',');
            logger.info(`Loading ${extPaths.length} Chrome extension(s) in Browser: ${joinedPaths}`);
            extensionFlags.push(`--load-extension=${joinedPaths}`);
            extensionFlags.push('--enable-extension-assets-sharing');
        } else {
            logger.info("No Chrome extensions found in extensions/ folder or CHROME_EXTENSIONS env var. Extension engine ready.");
        }

        logger.info(`Launching Browser Engine (${browserPath}) on DISPLAY :99 for URL: ${url}`);
        
        const launchOptions = {
            headless: false,
            executablePath: browserPath,
            env: {
                ...process.env,
                PULSE_SINK: 'v_sink',
                DISPLAY: ':99'
            },
            ignoreDefaultArgs: [
                '--disable-extensions',
                '--disable-component-update',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-client-side-phishing-detection'
            ],
            args: [
                `--user-data-dir=${userDataDir}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                '--window-position=0,0',
                '--start-maximized',
                '--start-fullscreen',
                '--hide-scrollbars',
                '--disable-infobars',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--display=:99',
                '--force-device-scale-factor=1',
                '--high-dpi-support=1',
                // GPU Acceleration & Maximum Performance for Smoothness
                '--enable-gpu-rasterization',
                '--enable-zero-copy',
                '--ignore-gpu-blocklist',
                '--use-gl=swiftshader',
                '--num-raster-threads=4',
                '--accelerated-2d-canvas=true',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                // ULTIMATE STEALTH & Chrome Web Store Component Extensions Enabled
                '--enable-extension-activity-logging',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process,EnablePasswordGeneration,TouchpadOverscrollHistoryNavigation',
                '--allow-running-insecure-content',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-dev-shm-usage',
                '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                ...extensionFlags
            ],
            defaultViewport: null
        };

        if (browserPath.includes('firefox')) {
            launchOptions.product = 'firefox';
        }

        browser = await puppeteer.launch(launchOptions);
        page = await browser.newPage();

        // Advanced Anti-Detection & WebRTC Spoofing on Document Load
        await page.evaluateOnNewDocument(() => {
            // 1. Webdriver stealth
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            try { delete navigator.__proto__.webdriver; } catch (e) {}

            // 2. Chrome runtime & webstore compatibility (Preserve native window.chrome & webstore)
            if (typeof window.chrome === 'undefined') {
                window.chrome = {};
            }
            if (!window.chrome.app) {
                window.chrome.app = {
                    isInstalled: false,
                    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
                };
            }

            // 3. Languages, Platform & Hardware info (Consistent with Linux UA)
            Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

            // 4. Mock Plugins
            const mockPlugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbobmdfcjooacpflkamhdfblbccbb', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
            Object.defineProperty(navigator, 'plugins', { get: () => mockPlugins });

            // 5. Spoof Media Devices for WebRTC Fingerprint
            if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                navigator.mediaDevices.enumerateDevices = async () => [
                    { deviceId: 'default', kind: 'audioinput', label: 'Internal Microphone (Realtek High Definition Audio)', groupId: 'group_audio' },
                    { deviceId: 'default', kind: 'videoinput', label: 'Integrated HD Camera (04f2:b604)', groupId: 'group_video' },
                    { deviceId: 'default', kind: 'audiooutput', label: 'Speakers / Headphones (Realtek Audio)', groupId: 'group_audio_out' }
                ];
            }
        });

        let targetUrl = url;
        const isZoom = targetUrl.includes('zoom.us');
        if (isZoom) {
            if (targetUrl.includes('zoom.us/j/')) {
                targetUrl = targetUrl.replace(/\/j\/([0-9]+)/, '/wc/join/$1');
            } else if (targetUrl.includes('zoom.us/s/')) {
                targetUrl = targetUrl.replace(/\/s\/([0-9]+)/, '/wc/join/$1');
            }
            logger.info(`Navigating to Zoom Web Client URL: ${targetUrl}`);
        } else {
            logger.info(`Navigating to Meeting URL: ${targetUrl}`);
        }

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });

        logger.info("Browser session initialized. Triggering Stealth Human Joiner...");
        let participantName;
        if (isZoom) {
            participantName = await joinZoomMeeting(page, customDisplayName);
        } else {
            participantName = await joinGoogleMeet(page, customDisplayName);
        }

        const vncPass = process.env.VNC_PASSWORD || "ghostsecretpass";
        // REMOVED fixed scale=0.8, using 'resize=scale' to let NoVNC auto-fit to any screen size (Phone/PC)
        const oneClickUrl = `${tunnelUrl}/vnc.html?autoconnect=true&password=${vncPass}&resize=scale`;
        logger.info(`Final Dashboard URL: ${oneClickUrl}`);

        return { url: oneClickUrl, participantName };
    } catch (error) {
        logger.error("Browser Launch Error:", error);
        throw error;
    }
}

/**
 * Capture a real-time screenshot of the meeting
 */
async function takeScreenshot() {
    if (!page) throw new Error("Browser session not active.");
    const screenshotPath = path.join(__dirname, '../../output/screenshot.png');
    await fs.ensureDir(path.dirname(screenshotPath));
    await page.screenshot({ path: screenshotPath });
    return screenshotPath;
}

async function closeBrowser() {
    try {
        if (antiKickInterval) {
            clearInterval(antiKickInterval);
            antiKickInterval = null;
        }
        if (browser) {
            logger.info("Closing Browser session...");
            await browser.close().catch(() => {});
        }
        if (tunnelInstance) {
            logger.info("Closing Serveo tunnel...");
            tunnelInstance.kill('SIGTERM');
        }
        // Cleanup virtual display bridge
        exec('pkill -f "ssh -o StrictHostKeyChecking=no -R 80:localhost:6080"');
        exec('pkill -f "google-chrome"');
        exec('pkill -f "Xvfb"');
    } catch (e) {
        logger.error(`Browser Cleanup Error: ${e.message}`);
    } finally {
        browser = null;
        page = null;
        tunnelInstance = null;
    }
}

/**
 * Downloads and installs any Chrome Web Store extension automatically by URL or Extension ID
 */
async function installExtensionFromUrl(inputUrlOrId) {
    const axios = require('axios');
    try {
        let extId = inputUrlOrId.trim();
        const match = extId.match(/\/detail\/[^\/]+\/([a-z0-9]+)/i) || extId.match(/([a-z]{32})/i);
        if (match) extId = match[1];

        if (!extId || extId.length < 24) {
            throw new Error("Invalid Extension ID or Web Store URL.");
        }

        logger.info(`Auto-downloading Chrome Extension ID: ${extId}...`);
        const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&os=linux&arch=x64&os_arch=x86_64&nacl_arch=x86-64&prod=chromecrx&prodchannel=unknown&prodversion=126.0.0.0&acceptformat=crx2,crx3&x=id%3D${extId}%26uc`;

        const targetDir = path.join(__dirname, '../../extensions', `ext_${extId}`);
        const zipPath = path.join(__dirname, '../../extensions', `${extId}.crx`);

        const response = await axios.get(crxUrl, { responseType: 'arraybuffer' });
        await fs.writeFile(zipPath, response.data);

        await fs.ensureDir(targetDir);
        const { execSync } = require('child_process');
        execSync(`unzip -o "${zipPath}" -d "${targetDir}" 2>/dev/null || true`);
        await fs.remove(zipPath).catch(() => {});

        logger.info(`✅ Successfully downloaded & unpacked Chrome Extension ${extId} into extensions/!`);
        return true;
    } catch (e) {
        logger.error(`Extension Download Error: ${e.message}`);
        return false;
    }
}

module.exports = {
    launchMeeting,
    takeScreenshot,
    closeBrowser,
    installExtensionFromUrl,
    getPage: () => page,
    getActiveParticipantName: () => activeParticipantName,
    getRandomHumanName
};

