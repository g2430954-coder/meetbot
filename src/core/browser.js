const puppeteer = require('puppeteer-core');
const { exec, spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const fs = require('fs-extra');

let browser = null;
let page = null;
let tunnelInstance = null;
let tunnelUrl = null;

/**
 * Initializes the virtual frame buffer and launches the meeting
 */
async function launchMeeting(url) {
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
                // ? FORCE RESOLUTION & SCALE
                '--force-device-scale-factor=1',
                '--high-dpi-support=1',
                // ? ULTIMATE STEALTH: Bypass Detection
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--no-first-run',
                '--no-default-browser-check',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
            defaultViewport: null
        });

        page = await browser.newPage();

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        logger.info("Browser session initialized.");

        // FIXED: Using 'resize=scale' and 'scale=0.8' to make the view more compact and fit on smaller screens
        const vncPass = process.env.VNC_PASSWORD || "";
        const oneClickUrl = `${tunnelUrl}/vnc.html?autoconnect=true&password=${vncPass}&resize=scale&scale=0.8`;
        logger.info(`Final Dashboard URL: ${oneClickUrl}`);

        return { url: oneClickUrl };
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

module.exports = { launchMeeting, takeScreenshot, closeBrowser, getPage: () => page };
