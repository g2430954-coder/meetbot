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
    console.error("❌ CRITICAL ERROR: TELEGRAM_BOT_TOKEN environment variable is missing in GitHub Secrets!");
    process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const meetingUrl = process.env.MEETING_URL;
const groupId = process.env.ALLOWED_GROUP_ID;

// Handoff data
const playerMessageId = process.env.PLAYER_MESSAGE_ID;
const chatId = process.env.CHAT_ID || groupId;

let isRecording = false;
let recordingStartTime = null;
let processedSegments = new Set();
let latestTranscript = "Waiting for speech...";
const runnerStartTime = Date.now();

const outputDir = path.join(__dirname, '../output');
const chunksDir = path.join(outputDir, 'chunks');

// Progress State
let targetProgress = 10; // Start at 10%
let visualProgress = 1;
let progressStatus = 'INITIALIZING';
let progressLog = "🖥 Step 1/5: Mounting 1080p Virtual Display (Xvfb :99)...";
let vncUrlGlobal = null;

// Use built-in chrome on GitHub
process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

/**
 * MASTER UI ORCHESTRATOR
 * A single, unified loop that updates Telegram in a rate-limit-safe way (every 2s)
 */
const masterUIInterval = setInterval(async () => {
    // 1. SMOOTH PROGRESS CALCULATION
    // If visual is behind target, move it closer.
    // If it's the same, and we're in a slow phase, creep it up by 1% to show life.
    if (visualProgress < targetProgress) {
        visualProgress += Math.max(1, Math.floor((targetProgress - visualProgress) / 4));
    } else if (visualProgress < 99 && (progressStatus === 'DEPLOYING' || progressStatus === 'FINALIZING')) {
        visualProgress += 1; // Creep up
    }

    // 2. PACE TARGET PROGRESS (Auto-advance stages if they take too long)
    if (progressStatus === 'DEPLOYING') {
        if (visualProgress > 20 && targetProgress < 30) targetProgress = 30;
        if (visualProgress > 45 && targetProgress < 60) targetProgress = 60;
        if (visualProgress > 75 && targetProgress < 90) targetProgress = 90;
        progressLog = getWorkflowStepLog(visualProgress);
    }

    // 3. GENERATE & PUSH UI
    const currentUI = ui.generatePlayerUI({
        status: progressStatus,
        progress: Math.min(100, visualProgress),
        meetingUrl: meetingUrl,
        vncUrl: vncUrlGlobal,
        stepLog: progressLog,
        partCount: processedSegments.size,
        latestTranscript: isRecording ? latestTranscript : null,
        timer: getTimerString()
    });

    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, currentUI.text, {
            parse_mode: 'Markdown', ...currentUI.markup
        });
    } catch (e) {
        // Silent catch for "message is not modified" or rate limits
    }
}, 2000); // 2 seconds is the sweet spot for Telegram stability

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
                    if (eventTime >= runnerStartTime - 5000) return true;
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
                    const lines = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:'));
                    if (lines.length > 0) {
                        latestTranscript = lines[lines.length - 1].replace(/^\[\d+:\d+\]\s*/, '');
                    }
                }
            }

            await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                caption: `🎥 GHOST meet Recording | Part ${processedSegments.size}\n📜 Snippet: ${latestTranscript.substring(0, 100)}...`
            }).catch(e => console.error(`Part upload error: ${e.message}`));
        }
    }
}

// Separate interval for heavy background tasks (signals and segments)
const backgroundTaskInterval = setInterval(async () => {
    if (isRecording) {
        const shouldStop = await checkStopSignal();
        if (shouldStop) {
            await finalizeAndUpload(vncUrlGlobal);
        } else {
            await processLatestSegments();
        }
    } else if (progressStatus === 'READY') {
        const recordSignal = await checkRecordSignal();
        if (recordSignal) await triggerStartRecording();
    }
}, 5000);

async function triggerStartRecording() {
    if (!isRecording) {
        console.log("🔴 Starting HD Stream Recording...");
        await recorder.startRecording();
        recordingStartTime = Date.now();
        isRecording = true;
        progressStatus = 'RECORDING';
        progressLog = '🔴 Capturing 1080p HD Feed + Audio (Stereo)...';
    }
}

async function finalizeAndUpload(vncUrl) {
    if (!isRecording) return;
    isRecording = false;

    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        progressLog = "⚙️ Finalizing capture and splitting final MP4 parts...";

        await recorder.stopRecording();

        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                processedSegments.add(file);
                const filePath = path.join(chunksDir, file);

                targetProgress = Math.min(95, targetProgress + 10);
                progressLog = `📤 Uploading final video parts (${processedSegments.size})...`;

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${processedSegments.size}`
                }).catch(() => {});
            }
        }

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'COMPLETED';
        progressLog = "✅ All real-time parts uploaded successfully. Engine hibernated.";

        setTimeout(() => {
            clearInterval(masterUIInterval);
            clearInterval(backgroundTaskInterval);
            process.exit(0);
        }, 10000);

    } catch (err) {
        logger.error(`Stop Error: ${err.message}`);
        process.exit(1);
    }
}

function getWorkflowStepLog(percent) {
    if (percent < 20) return "🖥 Step 1/5: Mounting 1080p Virtual Display (Xvfb :99)...";
    if (percent < 40) return "🔊 Step 2/5: Initializing PulseAudio Stereo Loopback Sink...";
    if (percent < 65) return "📡 Step 3/5: Establishing Serveo Unlimited Visual RDP Tunnel...";
    if (percent < 90) return "🌐 Step 4/5: Launching Stealth Chrome & Navigating to Meeting...";
    return "⚡️ Step 5/5: Finalizing Frame Buffer & Audio Binding...";
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
        progressLog = '✨ System Standby (100% Ready). Tap button below or send /record to start.';

        const app = express();
        app.get('/record', async (req, res) => { res.json({ status: 'recording' }); triggerStartRecording(); });
        app.get('/stop', async (req, res) => { res.json({ status: 'finalizing' }); finalizeAndUpload(vncUrlGlobal); });
        app.listen(8088);

    } catch (error) {
        console.error("Runner Execution Error:", error);
        process.exit(1);
    }
}

run();
