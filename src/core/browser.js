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
 * Helper function to discover unpacked Chrome extensions
 */
function getExtensionPaths() {
    const extensionPaths = [];
    const defaultExtensionsDir = path.join(__dirname, '../../extensions');

    const checkAndAdd = (dirPath) => {
        if (!dirPath) return;
        const absPath = path.resolve(dirPath);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
            const manifestPath = path.join(absPath, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                if (!extensionPaths.includes(absPath)) {
                    extensionPaths.push(absPath);
                }
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
            checkAndAdd(defaultExtensionsDir);
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

    for (let attempt = 0; attempt < 5; attempt++) {
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
                const isVisible = await page.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
                }, btn);

                if (isVisible) {
                    const btnText = await page.evaluate(el => el.textContent, btn);
                    logger.info(`Clicking Google Meet join button: "${btnText.trim()}"`);
                    await btn.click();
                    joined = true;
                    break;
                }
            }
        }

        if (joined) break;

        // Backup check for Google Meet primary JSName button
        try {
            const jsNameBtn = await page.$('button[jsname="Qx7uJf"], button[jsname="CQA6B"]');
            if (jsNameBtn) {
                logger.info("Clicking Google Meet primary action button via JSName...");
                await jsNameBtn.click();
                joined = true;
                break;
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
 * Background watcher to auto-handle host denials, popups, or kicks
 */
function startAntiKickWatcher(page) {
    setInterval(async () => {
        try {
            if (!page || page.isClosed()) return;

            const pageText = await page.evaluate(() => document.body ? document.body.innerText || '' : '');
            if (pageText.includes("Someone in the call denied your request") || pageText.includes("You can't join this call")) {
                logger.warn("Join request denied by meeting host. Retrying automatically with fresh human identity...");
                const newName = getRandomHumanName();
                await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
                await joinGoogleMeet(page, newName).catch(() => {});
            }

            // Dismiss "Got it" inside call
            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const text = await page.evaluate(el => el.textContent || '', btn);
                if (text.match(/^got it$/i) || text.match(/^dismiss$/i)) {
                    await btn.click().catch(() => {});
                }
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
            tunnelInstance = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-R', '80:localhost:6080', 'serveo.net'], {
                detached: false
            });

            tunnelUrl = await new Promise((resolve) => {
                let found = false;
                const timeout = setTimeout(() => {
                    if (!found) {
                        logger.warn("Serveo URL extraction timed out. Using fallback.");
                        resolve("http://localhost:6080");
                    }
                }, 25000);

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
                    resolve("http://localhost:6080");
                });
            });

            logger.info(`SUCCESS: Serveo tunnel established: ${tunnelUrl}`);
        } catch (err) {
            logger.error(`Serveo failed: ${err.message}`);
            tunnelUrl = "http://localhost:6080";
        }

        const chromePath = process.env.CHROME_PATH || 
            (fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : '/usr/bin/chromium');

        const extPaths = getExtensionPaths();
        const extensionFlags = [];
        if (extPaths.length > 0) {
            const joinedPaths = extPaths.join(',');
            logger.info(`Loading ${extPaths.length} Chrome extension(s): ${joinedPaths}`);
            extensionFlags.push(`--disable-extensions-except=${joinedPaths}`);
            extensionFlags.push(`--load-extension=${joinedPaths}`);
        } else {
            logger.info("No Chrome extensions found in extensions/ folder or CHROME_EXTENSIONS env var.");
        }

        logger.info(`Launching Ultimate Stealth Puppeteer on DISPLAY :99 for URL: ${url}`);
        browser = await puppeteer.launch({
            headless: false,
            executablePath: chromePath,
            args: [
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
                // ULTIMATE STEALTH: Bypass Anti-Bot & Fingerprinting
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process,EnablePasswordGeneration,TouchpadOverscrollHistoryNavigation',
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-site-isolation-trials',
                '--disable-dev-shm-usage',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                ...extensionFlags
            ],
            defaultViewport: null
        });

        page = await browser.newPage();

        // Advanced Anti-Detection & WebRTC Spoofing on Document Load
        await page.evaluateOnNewDocument(() => {
            // 1. Webdriver stealth
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            try { delete navigator.__proto__.webdriver; } catch (e) {}

            // 2. Chrome runtime mock
            window.chrome = {
                runtime: {
                    connect: () => {},
                    sendMessage: () => {},
                    onMessage: { addListener: () => {} }
                },
                loadTimes: () => {},
                csi: () => {},
                app: {}
            };

            // 3. Languages, Platform & Hardware info
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

        logger.info(`Navigating to Google Meet URL: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        logger.info("Browser session initialized. Triggering Google Meet Human Joiner...");
        const participantName = await joinGoogleMeet(page, customDisplayName);

        const vncPass = process.env.VNC_PASSWORD || "";
        const oneClickUrl = `${tunnelUrl}/vnc.html?autoconnect=true&password=${vncPass}&resize=scale&scale=0.8`;
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
    if (browser) await browser.close();
    if (tunnelInstance) tunnelInstance.kill();
    exec('pkill Xvfb');
}

module.exports = {
    launchMeeting,
    takeScreenshot,
    closeBrowser,
    getPage: () => page,
    getActiveParticipantName: () => activeParticipantName,
    getRandomHumanName
};
