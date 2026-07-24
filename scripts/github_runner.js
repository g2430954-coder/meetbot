const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const browserManager = require('../src/core/browser');
const recorder = require('../src/core/recorder');
const transcriber = require('../src/core/transcriber');
const logger = require('../src/utils/logger');
const ui = require('../src/utils/ui');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("❌ CRITICAL ERROR: TELEGRAM_BOT_TOKEN environment variable is missing!");
    process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const meetingUrl = process.env.MEETING_URL;
const groupId = process.env.ALLOWED_GROUP_ID;

const playerMessageId = process.env.PLAYER_MESSAGE_ID;
const chatId = process.env.CHAT_ID || groupId;

let isRecording = false;
let recordingStartTime = null;
let processedSegments = new Set();
let latestTranscript = "";
const runnerStartTime = Date.now();

const outputDir = path.join(__dirname, '../output');
const chunksDir = path.join(outputDir, 'chunks');
const masterTranscriptPath = path.join(outputDir, 'GHOST_meet_Full_Transcript.txt');

// Ensure directories exist immediately
fs.ensureDirSync(outputDir);
fs.ensureDirSync(chunksDir);

// UI State Management
let targetProgress = 10;
let visualProgress = 1;
let progressStatus = 'INITIALIZING';
let vncUrlGlobal = null;
let systemLogs = ["Kernel mounting display...", "Initializing visual bridge..."];

// Throttling for Telegram
let lastUIUpdate = 0;
const UI_UPDATE_INTERVAL = 2500; // 2.5s is safest to avoid 429

// Use built-in chrome on GitHub
process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

/**
 * SMOOTH TICKER (100ms)
 * Increments visual progress smoothly in background
 */
setInterval(() => {
    if (visualProgress < targetProgress) {
        visualProgress += 0.2; // Very slow incremental creep
    } else if (visualProgress < 99 && (progressStatus === 'DEPLOYING' || progressStatus === 'FINALIZING')) {
        visualProgress += 0.05; // Ghost creep to show life
    }
}, 100);

/**
 * MASTER UI PUSHER (Throttled)
 */
const masterUIInterval = setInterval(async () => {
    const now = Date.now();
    if (now - lastUIUpdate < UI_UPDATE_INTERVAL) return;
    lastUIUpdate = now;

    if (progressStatus === 'DEPLOYING') {
        const newLog = getWorkflowStepLog(Math.floor(visualProgress));
        if (newLog && !systemLogs.includes(newLog)) {
            systemLogs.push(newLog);
            if (systemLogs.length > 3) systemLogs.shift();
        }
    }

    const currentUI = ui.generatePlayerUI({
        status: isRecording ? 'RECORDING' : progressStatus,
        progress: Math.floor(Math.min(100, visualProgress)),
        meetingUrl: meetingUrl,
        vncUrl: vncUrlGlobal,
        partCount: processedSegments.size,
        latestTranscript: isRecording ? latestTranscript : null,
        timer: getTimerString(),
        logs: systemLogs
    });

    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, currentUI.text, {
            parse_mode: 'Markdown', ...currentUI.markup
        });
    } catch (e) {
        if (e.description && e.description.includes("message is not modified")) return;
        console.warn("UI Push throttled by Telegram (429 or network).");
    }
}, 500); // Check every 500ms, but only push if 2.5s passed

function getTimerString() {
    if (!recordingStartTime || !isRecording) return null;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

async function checkRecordSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        if (!token || !owner || !repo) return false;

        const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/events`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            timeout: 3000
        });

        if (Array.isArray(res.data)) {
            for (const ev of res.data) {
                if (ev.type === 'RepositoryDispatchEvent' && ev.payload && ev.payload.action === 'record_ghost_runner') {
                    const eventTime = new Date(ev.created_at).getTime();
                    // Increased window to 10s to ensure signal is caught
                    if (eventTime >= runnerStartTime - 10000) return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

async function checkStopSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        if (!token || !owner || !repo) return false;

        const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/events`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            timeout: 3000
        });

        if (Array.isArray(res.data)) {
            for (const ev of res.data) {
                if (ev.type === 'RepositoryDispatchEvent' && ev.payload && ev.payload.action === 'stop_ghost_runner') {
                    const eventTime = new Date(ev.created_at).getTime();
                    if (eventTime >= runnerStartTime - 5000) return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

async function processLatestSegments() {
    if (!fs.existsSync(chunksDir)) return;
    const files = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();

    for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        if (!processedSegments.has(file)) {
            processedSegments.add(file);
            const filePath = path.join(chunksDir, file);

            const audioPath = path.join(outputDir, `${file}.wav`);
            const audioExtracted = await recorder.extractAudio(filePath, audioPath);

            if (audioExtracted) {
                const transcriptPath = await transcriber.transcribe(audioPath);
                if (transcriptPath && fs.existsSync(transcriptPath)) {
                    const text = fs.readFileSync(transcriptPath, 'utf8');
                    const cleanText = text.replace(/━━━━━━━━━━━━━━━━━━━━━━\n/g, '').replace(/✨ GHOST meet \| AI TRANSCRIPTION.*\n/g, '').trim();
                    fs.appendFileSync(masterTranscriptPath, cleanText + "\n");

                    const lines = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:'));
                    if (lines.length > 0) {
                        latestTranscript = lines[lines.length - 1].replace(/^\[\d+:\d+\]\s*/, '');
                    }
                }
            }

            await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                caption: `🎥 GHOST meet Recording | Part ${processedSegments.size}\n📜 Text: ${latestTranscript.substring(0, 500)}`
            }).catch(e => console.error(`Part upload error: ${e.message}`));
        }
    }
}

const backgroundTaskInterval = setInterval(async () => {
    try {
        const page = browserManager.getPage();
        if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            console.log("⚠️ Meeting page closed or disconnected. Auto-finalizing...");
            await finalizeAndUpload(vncUrlGlobal);
            return;
        }
    } catch (e) {}

    if (isRecording) {
        const shouldStop = await checkStopSignal();
        if (shouldStop) {
            await finalizeAndUpload(vncUrlGlobal);
        } else {
            await processLatestSegments();
        }
    } else {
        // ALWAYS check for record signal (Manual Override)
        const recordSignal = await checkRecordSignal();
        if (recordSignal) await triggerStartRecording();
    }
}, 1500);

async function triggerStartRecording() {
    if (!isRecording) {
        console.log("🔴 Starting HD Stream Recording...");
        await fs.ensureDir(outputDir);
        await fs.ensureDir(chunksDir);
        fs.writeFileSync(masterTranscriptPath, "✨ GHOST meet | FULL AI TRANSCRIPT\n━━━━━━━━━━━━━━━━━━━━━━\n\n");
        await recorder.startRecording();
        recordingStartTime = Date.now();
        isRecording = true;
        progressStatus = 'RECORDING';
        systemLogs.push("Auto-Capture Active: Recording started.");
        if (systemLogs.length > 3) systemLogs.shift();
    }
}

async function finalizeAndUpload(vncUrl) {
    if (!isRecording) return;
    isRecording = false;

    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        systemLogs.push("Stopping capture, finalizing segments...");
        if (systemLogs.length > 3) systemLogs.shift();

        await recorder.stopRecording();

        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                processedSegments.add(file);
                const filePath = path.join(chunksDir, file);
                targetProgress = Math.min(95, targetProgress + 10);
                systemLogs.push(`Uploading final part ${processedSegments.size}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${processedSegments.size}`
                }).catch(() => {});
            }
        }

        if (fs.existsSync(masterTranscriptPath)) {
            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(masterTranscriptPath), filename: 'GHOST_meet_Full_Transcript.txt' }, {
                caption: "📜 *Full AI Meeting Transcript*",
                parse_mode: 'Markdown'
            });
        }

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'COMPLETED';
        systemLogs.push("All assets secured. Engine hibernated.");
        if (systemLogs.length > 3) systemLogs.shift();

        setTimeout(() => {
            clearInterval(masterUIInterval);
            clearInterval(backgroundTaskInterval);
            process.exit(0);
        }, 10000);

    } catch (err) {
        console.error("Finalize Error:", err);
        process.exit(1);
    }
}

function getWorkflowStepLog(percent) {
    if (percent < 20) return "Display :99 mounted.";
    if (percent < 40) return "Audio bridge established.";
    if (percent < 65) return "RDP tunnel secured.";
    if (percent < 90) return "Chrome engine navigated.";
    return "Frame buffer synced.";
}

async function run() {
    try {
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl}`);
        progressStatus = 'DEPLOYING';
        targetProgress = 20;

        const tunnel = await browserManager.launchMeeting(meetingUrl);
        vncUrlGlobal = tunnel.url;

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'READY';
        systemLogs.push("Ready for capture.");
        if (systemLogs.length > 3) systemLogs.shift();

        const app = express();
        app.get('/record', async (req, res) => { res.json({ status: 'recording' }); triggerStartRecording(); });
        app.get('/stop', async (req, res) => { res.json({ status: 'finalizing' }); finalizeAndUpload(vncUrlGlobal); });
        app.listen(8088);

        // ⚡ AUTOMATIC ZERO-CLICK RECORDING START
        console.log("⚡ Auto-starting HD capture (Zero-Click Automation)...");
        await triggerStartRecording();

    } catch (error) {
        console.error("Runner Execution Error:", error);
        process.exit(1);
    }
}

run();

async function reportError(err) {
    console.error("GHOST Runner Error:", err);
    const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined,
            errorUI.text + `\n\n🚨 *System Failure:* ${err.message || err}`,
            { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(chatId, `❌ *Runner Process Terminated:* ${err.message || err}`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

process.on('uncaughtException', async (err) => {
    await reportError(err);
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    await reportError(reason);
    process.exit(1);
});
