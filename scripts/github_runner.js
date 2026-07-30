const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');
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
const slot = process.env.SLOT || 1;

const playerMessageId = process.env.PLAYER_MESSAGE_ID;
const chatId = process.env.CHAT_ID || groupId;
const GHOST_API_KEY = process.env.GHOST_API_KEY || "GHOST_DEFAULT_SECURE_KEY_999";

let isRecording = false;
let recordingStartTime = null;
let processedSegments = new Set();
let latestTranscript = "";
let totalWordCount = 0;
let isProcessingSegment = false;
const runnerStartTime = Date.now();

const outputDir = path.join(__dirname, '../output');
const chunksDir = path.join(outputDir, 'chunks');
const masterTranscriptPath = path.join(outputDir, 'GHOST_meet_PERFECT_Transcript.txt');

fs.ensureDirSync(outputDir);
fs.ensureDirSync(chunksDir);

// UI State Management
let targetProgress = 10;
let visualProgress = 1;
let progressStatus = 'INITIALIZING';
let vncUrlGlobal = null;
let activeParticipantName = null;
let systemLogs = ["Kernel mounting display...", "Initializing visual bridge..."];

// Schedule state & Simplified Timezone Fix
const scheduledStart = process.env.SCHEDULED_START;
const scheduledEnd = process.env.SCHEDULED_END;
const TZ_OFFSET_HOURS = 5;
const TZ_OFFSET_MINS = 30; // IST

let lastUIUpdate = 0;
const UI_UPDATE_INTERVAL = 2500; // Liquid UI Speed

process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

function parseTimeToToday(timeStr) {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
    date.setUTCHours(date.getUTCHours() - TZ_OFFSET_HOURS);
    date.setUTCMinutes(date.getUTCMinutes() - TZ_OFFSET_MINS);
    return date;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

function getCountdownString() {
    const now = new Date();
    const startTime = parseTimeToToday(scheduledStart);
    const endTime = parseTimeToToday(scheduledEnd);
    if (startTime && now < startTime) return formatTime(Math.floor((startTime - now) / 1000));
    if (endTime && isRecording) {
        const diff = Math.floor((endTime - now) / 1000);
        return diff > 0 ? formatTime(diff) : `00:00`;
    }
    return null;
}

function getSessionUptime() { return formatTime(Math.floor((Date.now() - runnerStartTime) / 1000)); }
function getWorkflowExpiry() {
    const remaining = Math.max(0, (360 * 60) - Math.floor((Date.now() - runnerStartTime) / 1000));
    return formatTime(remaining);
}

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
        participantName: activeParticipantName,
        wordCount: totalWordCount,
        logs: systemLogs,
        timers: {
            uptime: getSessionUptime(),
            capture: isRecording ? formatTime(Math.floor((Date.now() - recordingStartTime) / 1000)) : null,
            countdown: getCountdownString(),
            expiry: getWorkflowExpiry()
        },
        schedule: scheduledStart ? { start: scheduledStart, end: scheduledEnd } : null,
        slot: slot
    });

    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, currentUI.text, {
            parse_mode: 'Markdown', ...currentUI.markup
        });
    } catch (e) {}
}, 500);

async function getGhostSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/actions/variables/GHOST_SIGNAL`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            timeout: 3000
        });
        return res.data ? res.data.value : null;
    } catch (e) { return null; }
}

const GHOST_API_KEY = process.env.GHOST_API_KEY || "GHOST_DEFAULT_SECURE_KEY_999";

async function getBotHostSignal() {
    try {
        const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
        const res = await axios.get(`${botHost}/get_signal`, {
            params: { chat_id: chatId, slot: slot, key: GHOST_API_KEY },
            timeout: 2500
        });
        return res.data ? res.data.signal : null;
    } catch (e) { return null; }
}

async function processLatestSegments() {
    if (!fs.existsSync(chunksDir) || isProcessingSegment) return;
    const files = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();

    for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        if (!processedSegments.has(file)) {
            isProcessingSegment = true;
            try {
                const filePath = path.join(chunksDir, file);
                const audioPath = path.join(outputDir, `${file}.wav`);
                await recorder.extractAudio(filePath, audioPath);

                const transcriptPath = await transcriber.transcribe(audioPath);
                if (transcriptPath && fs.existsSync(transcriptPath)) {
                    const text = fs.readFileSync(transcriptPath, 'utf8');
                    const cleanText = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:')).join(' ');
                    if (cleanText) {
                        latestTranscript = cleanText;
                        totalWordCount += cleanText.split(/\s+/).length;
                    }
                }

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Part ${processedSegments.size + 1}\n📜 Text: ${latestTranscript.substring(0, 500)}`
                }).catch(() => {});

                processedSegments.add(file);
                if (fs.existsSync(audioPath)) fs.removeSync(audioPath);
            } finally {
                isProcessingSegment = false;
            }
        }
    }
}

async function generateMasterTranscript() {
    systemLogs.push("DeepScan HQ Reconstruction started...");
    if (systemLogs.length > 3) systemLogs.shift();
    const videoFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
    if (videoFiles.length === 0) return null;
    const masterWav = path.join(outputDir, 'master_recovery.wav');
    try {
        const fileListPath = path.join(outputDir, 'filelist.txt');
        fs.writeFileSync(fileListPath, videoFiles.map(f => `file '${path.join(chunksDir, f)}'`).join('\n'));
        spawnSync('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', fileListPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', masterWav]);
        if (fs.existsSync(masterWav)) {
            const { execSync } = require('child_process');
            execSync(`python3 src/core/transcribe.py "${masterWav}" "${masterTranscriptPath}" --master`);
            return masterTranscriptPath;
        }
    } catch (e) { console.error("Master Transcript Error:", e.message); }
    return null;
}

const backgroundTaskInterval = setInterval(async () => {
    const now = new Date();
    const startTime = parseTimeToToday(scheduledStart);
    const endTime = parseTimeToToday(scheduledEnd);
    if (isRecording) {
        const shouldStop = await checkStopSignal() || (endTime && now >= endTime);
        if (shouldStop) await finalizeAndUpload(vncUrlGlobal);
        else await processLatestSegments();
    } else {
        const recordSignal = await checkRecordSignal() || (startTime && now >= startTime);
        if (recordSignal) await triggerStartRecording();
    }
}, 1000); // 1s Precise Polling

async function triggerStartRecording() {
    if (isRecording) return;
    isRecording = true;
    console.log("🔴 Auto-Start Engaged...");
    try {
        await recorder.startRecording();
        recordingStartTime = Date.now();
        progressStatus = 'RECORDING';
        systemLogs.push("Engine engaged: Recording started.");
    } catch (e) { isRecording = false; }
}

async function finalizeAndUpload(vncUrl) {
    isRecording = false;
    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        systemLogs.push("Finalizing DeepScan assets...");
        await recorder.stopRecording();
        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(path.join(chunksDir, file)) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${processedSegments.size + 1}`
                }).catch(() => {});
                processedSegments.add(file);
            }
        }
        const finalPath = await generateMasterTranscript();
        if (finalPath && fs.existsSync(finalPath)) {
            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(finalPath), filename: 'GHOST_meet_PERFECT_Transcript.txt' }, {
                caption: "📜 *GHOST meet | 100% PERFECT AI TRANSCRIPT*\n(Zero-Loss DeepScan Complete)", parse_mode: 'Markdown'
            }).catch(() => {});
        }
        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'COMPLETED';
        systemLogs.push("Mission successful. System offline.");
        setTimeout(() => process.exit(0), 10000);
    } catch (err) { process.exit(1); }
}

function getWorkflowStepLog(percent) {
    if (percent < 20) return "Display mounted.";
    if (percent < 40) return "Audio synced.";
    if (percent < 65) return "Tunnel secured.";
    if (percent < 90) return "Chrome navigated.";
    return "Kernel ready.";
}

async function run() {
    try {
        progressStatus = 'DEPLOYING';
        targetProgress = 20;
        const now = new Date();
        const schedTime = parseTimeToToday(scheduledStart);
        if (schedTime) systemLogs.push(`T-Minus: ${Math.floor((schedTime - now) / 60000)}m to Auto-Start.`);
        const tunnel = await browserManager.launchMeeting(meetingUrl, process.env.DISPLAY_NAME);
        vncUrlGlobal = tunnel.url;
        activeParticipantName = tunnel.participantName;

        // Auto-Register VNC URL with Bot Terminal
        try {
            const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
            await axios.get(`${botHost}/register_vnc`, {
                params: { vncUrl: vncUrlGlobal, chat_id: chatId, slot: slot, key: GHOST_API_KEY },
                timeout: 5000
            });
            logger.info("Successfully registered VNC URL with bot.");
        } catch (e) {
            logger.warn(`Failed to register VNC URL: ${e.message}`);
        }

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = scheduledStart ? 'SCHEDULED' : 'READY';
        systemLogs.push(`Identity: ${activeParticipantName}`);
        const expressApp = express();
        expressApp.get('/bridge_health', (req, res) => res.json({ status: 'active' }));
        expressApp.get('/record', async (req, res) => { await triggerStartRecording(); res.json({ success: true }); });
        expressApp.get('/stop', async (req, res) => { res.json({ success: true }); await finalizeAndUpload(vncUrlGlobal); });
        expressApp.listen(6080);
    } catch (error) { process.exit(1); }
}

run();

setInterval(() => {
    if (visualProgress < targetProgress) visualProgress += 0.25;
    else if (visualProgress < 99 && (progressStatus === 'DEPLOYING' || progressStatus === 'FINALIZING')) visualProgress += 0.05;
}, 100);

process.on('uncaughtException', async (err) => {
    try { await bot.telegram.sendMessage(chatId, `🚨 *System Failure:* ${err.message}`, { parse_mode: 'Markdown' }); } catch(e){}
    await cleanup();
    process.exit(1);
});

async function cleanup() {
    console.log("🏁 Triggering Engine Cleanup...");
    clearInterval(masterUIInterval);
    clearInterval(backgroundTaskInterval);
    await recorder.stopRecording().catch(() => {});
    await browserManager.closeBrowser().catch(() => {});
}

process.on('SIGINT', async () => {
    console.log("Caught interrupt signal (SIGINT)");
    await cleanup();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log("Caught termination signal (SIGTERM)");
    await cleanup();
    process.exit(0);
});
