const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const browserManager = require('../src/core/browser');
const recorder = require('../src/core/recorder');
const logger = require('../src/utils/logger');
const ui = require('../src/utils/ui');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("❌ CRITICAL ERROR: TELEGRAM_BOT_TOKEN environment variable is missing in GitHub Secrets!");
    console.error("👉 Fix: Go to GitHub Repo -> Settings -> Secrets and variables -> Actions -> New repository secret");
    console.error("   Name: TELEGRAM_BOT_TOKEN");
    console.error("   Value: <Your Telegram Bot Token>");
    process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const meetingUrl = process.env.MEETING_URL;
const groupId = process.env.ALLOWED_GROUP_ID;

// Handoff data
const playerMessageId = process.env.PLAYER_MESSAGE_ID;
const chatId = process.env.CHAT_ID || groupId;

let isRecording = false;
let heartbeatInterval = null;
let recordingStartTime = null;
const runnerStartTime = Date.now();

// Use built-in chrome on GitHub
process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

/**
 * Check if a stop_ghost_runner dispatch event was sent to GitHub API
 */
async function checkStopSignal() {
    try {
        const token = process.env.PAT_TOKEN;
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        if (!token || !owner || !repo) return false;

        const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/events`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout: 3000
        });

        if (Array.isArray(res.data)) {
            for (const ev of res.data) {
                if (ev.type === 'RepositoryDispatchEvent' && ev.payload && ev.payload.action === 'stop_ghost_runner') {
                    const eventTime = new Date(ev.created_at).getTime();
                    if (eventTime >= runnerStartTime - 5000) {
                        console.log("🛑 Stop signal detected from GitHub Dispatch!");
                        return true;
                    }
                }
            }
        }
    } catch (e) {
        // Silent catch for transient API rate-limiting or network issues
    }
    return false;
}

/**
 * Animated Heartbeat for Telegram Player UI with real-time timer & stop check
 */
async function startHeartbeat(vncUrl) {
    recordingStartTime = Date.now();
    heartbeatInterval = setInterval(async () => {
        if (!isRecording) {
            clearInterval(heartbeatInterval);
            return;
        }

        // Check for stop signal from Telegram Bot
        const shouldStop = await checkStopSignal();
        if (shouldStop) {
            clearInterval(heartbeatInterval);
            await finalizeAndUpload(vncUrl);
            return;
        }

        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const secs = (elapsed % 60).toString().padStart(2, '0');
        const timeStr = `${mins}:${secs}`;

        const updatedUI = ui.generatePlayerUI({
            status: 'RECORDING',
            timer: timeStr,
            meetingUrl: vncUrl || meetingUrl
        });

        try {
            await bot.telegram.editMessageText(chatId, playerMessageId, null, updatedUI.text, {
                parse_mode: 'Markdown', ...updatedUI.markup
            });
        } catch (e) {
            if (e.description && e.description.includes("message is not modified")) return;
            console.error("Heartbeat update error:", e.message);
        }
    }, 3000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

async function finalizeAndUpload(vncUrl) {
    if (!isRecording) return;
    stopHeartbeat();
    isRecording = false;

    try {
        // Phase 1: Stop FFMPEG
        const finalizingUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 20, meetingUrl: vncUrl || meetingUrl });
        await bot.telegram.editMessageText(chatId, playerMessageId, null, finalizingUI.text, { parse_mode: 'Markdown' });

        const stopPromise = recorder.stopRecording();

        // Phase 2: Processing & STT
        const processingUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 50, meetingUrl: vncUrl || meetingUrl });
        await bot.telegram.editMessageText(chatId, playerMessageId, null, processingUI.text, { parse_mode: 'Markdown' });

        const assets = await stopPromise;

        // Phase 3: Uploading Video Segments & Transcript
        const uploadingUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 80, meetingUrl: vncUrl || meetingUrl });
        await bot.telegram.editMessageText(chatId, playerMessageId, null, uploadingUI.text, { parse_mode: 'Markdown' });

        for (let i = 0; i < assets.videoChunks.length; i++) {
            await bot.telegram.sendVideo(chatId, { source: assets.videoChunks[i] }, { 
                caption: `🎥 GHOST meet Recording | Part ${i+1} of ${assets.videoChunks.length}` 
            });
        }

        if (assets.transcriptPath) {
            await bot.telegram.sendDocument(chatId, { source: assets.transcriptPath }, { 
                caption: "📜 *AI Meeting Transcript (100% English Output)*", 
                parse_mode: 'Markdown' 
            });
        }

        const completedUI = ui.generatePlayerUI({ status: 'COMPLETED', progress: 100, partCount: assets.videoChunks.length, meetingUrl: vncUrl || meetingUrl });
        await bot.telegram.editMessageText(chatId, playerMessageId, null, completedUI.text, { parse_mode: 'Markdown' });

        setTimeout(() => {
            console.log("GHOST Runner completed successfully. Exiting.");
            process.exit(0);
        }, 5000);

    } catch (err) {
        logger.error(`Stop Error: ${err.message}`);
        process.exit(1);
    }
}

async function run() {
    try {
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl}`);

        // 1. Launch Stealth Browser & Serveo VNC Tunnel
        const tunnel = await browserManager.launchMeeting(meetingUrl);

        // 2. Start HD Stream Capture automatically
        await recorder.startRecording();
        isRecording = true;
        startHeartbeat(tunnel.url);

        // 3. Update Telegram Message with Live RDP Viewer Link & RECORDING state
        const recordingUI = ui.generatePlayerUI({ status: 'RECORDING', timer: '0:00', meetingUrl: meetingUrl, vncUrl: tunnel.url });
        await bot.telegram.editMessageText(chatId, playerMessageId, null, recordingUI.text, {
            parse_mode: 'Markdown', ...recordingUI.markup
        });

        // 4. Express HTTP control server for Render bot commands
        const app = express();
        app.get('/stop', async (req, res) => {
            res.json({ status: 'finalizing' });
            finalizeAndUpload(tunnel.url);
        });

        app.get('/status', (req, res) => {
            res.json({ isRecording, meetingUrl, vncUrl: tunnel.url });
        });

        app.listen(8088, () => {
            console.log("Runner Control API active on port 8088");
        });

    } catch (error) {
        console.error("Runner Execution Error:", error);
        process.exit(1);
    }
}

run();
