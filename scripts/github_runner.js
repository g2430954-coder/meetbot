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
let activeParticipantName = null;
let systemLogs = ["Kernel mounting display...", "Initializing visual bridge..."];

// Schedule state
const scheduledStart = process.env.SCHEDULED_START; // HH:mm
const scheduledEnd = process.env.SCHEDULED_END;     // HH:mm

// Throttling for Telegram
let lastUIUpdate = 0;
const UI_UPDATE_INTERVAL = 4000;

// Use built-in chrome on GitHub
process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

/**
 * SMOOTH TICKER
 */
setInterval(() => {
    if (visualProgress < targetProgress) {
        visualProgress += 0.2;
    } else if (visualProgress < 99 && (progressStatus === 'DEPLOYING' || progressStatus === 'FINALIZING')) {
        visualProgress += 0.05;
    }
}, 100);

/**
 * Helper to parse time strings (HH:mm) into Date objects for today
 */
function parseTimeToToday(timeStr) {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
}

/**
 * Helper to format duration in seconds into MM:SS
 */
function formatTime(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

function getCountdownString() {
    const now = new Date();
    const startTime = parseTimeToToday(scheduledStart);
    const endTime = parseTimeToToday(scheduledEnd);

    if (startTime && now < startTime) {
        const diff = Math.floor((startTime - now) / 1000);
        return formatTime(diff);
    }

    if (endTime && isRecording) {
        const diff = Math.floor((endTime - now) / 1000);
        if (diff > 0) return formatTime(diff);
        return `00:00`;
    }

    return null;
}

function getSessionUptime() {
    const elapsed = Math.floor((Date.now() - runnerStartTime) / 1000);
    return formatTime(elapsed);
}

function getWorkflowExpiry() {
    // 360 minutes timeout from meet.yml
    const maxSeconds = 360 * 60;
    const elapsed = Math.floor((Date.now() - runnerStartTime) / 1000);
    const remaining = Math.max(0, maxSeconds - elapsed);
    return formatTime(remaining);
}

/**
 * MASTER UI PUSHER
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
        participantName: activeParticipantName,
        logs: systemLogs,
        timers: {
            uptime: getSessionUptime(),
            capture: getTimerString(),
            countdown: getCountdownString(),
            expiry: getWorkflowExpiry()
        },
        schedule: scheduledStart ? { start: scheduledStart, end: scheduledEnd } : null
    });

    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, currentUI.text, {
            parse_mode: 'Markdown', ...currentUI.markup
        });
    } catch (e) {
        if (e.description && e.description.includes("message is not modified")) return;
        if (e.description && e.description.includes("Too Many Requests")) {
            const waitSec = (parseInt(e.description.match(/\d+/)?.[0]) || 5) + 1;
            lastUIUpdate = Date.now() + (waitSec * 1000);
            return;
        }
    }
}, 1000);

function getTimerString() {
    if (!recordingStartTime || !isRecording) return null;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    return formatTime(elapsed);
}

async function checkRecordSignal() {
    const sig1 = await getGhostSignal();
    const sig2 = await getBotHostSignal();
    return sig1 === 'RECORD' || sig2 === 'RECORD';
}

async function checkStopSignal() {
    const sig1 = await getGhostSignal();
    const sig2 = await getBotHostSignal();
    return sig1 === 'STOP' || sig2 === 'STOP';
}

async function getGhostSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        if (!token || !owner || !repo) return null;
        const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/actions/variables/GHOST_SIGNAL`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
            timeout: 3000
        });
        return res.data ? res.data.value : null;
    } catch (e) { return null; }
}

async function getBotHostSignal() {
    try {
        const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
        const res = await axios.get(`${botHost}/get_signal`, { timeout: 2500 });
        return res.data ? res.data.signal : null;
    } catch (e) { return null; }
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
                    if (cleanText) fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                    const lines = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:'));
                    if (lines.length > 0) latestTranscript = lines[lines.length - 1].replace(/^\[\d+:\d+\]\s*/, '');
                }
            }
        }
    }
}

/**
 * SCHEDULE MANAGER
 */
const backgroundTaskInterval = setInterval(async () => {
    const now = new Date();
    const startTime = parseTimeToToday(scheduledStart);
    const endTime = parseTimeToToday(scheduledEnd);

    if (isRecording) {
        const shouldStop = await checkStopSignal();
        // AUTO-STOP check
        const isPastEndTime = endTime && now >= endTime;

        if (shouldStop || isPastEndTime) {
            if (isPastEndTime) systemLogs.push("Auto-Stop: Schedule completed.");
            await finalizeAndUpload(vncUrlGlobal);
        } else {
            await processLatestSegments();
        }
    } else {
        const recordSignal = await checkRecordSignal();
        // AUTO-START check
        const isStartTimeReached = startTime && now >= startTime;

        if (recordSignal || isStartTimeReached) {
            if (isStartTimeReached) systemLogs.push("Auto-Start: Schedule reached.");
            await triggerStartRecording();
        }
    }
}, 1500);

async function triggerStartRecording() {
    if (!isRecording) {
        console.log("🔴 Starting HD Stream Recording...");
        fs.writeFileSync(masterTranscriptPath, "✨ GHOST meet | FULL AI TRANSCRIPT\n━━━━━━━━━━━━━━━━━━━━━━\n\n");
        await recorder.startRecording();
        recordingStartTime = Date.now();
        isRecording = true;
        progressStatus = 'RECORDING';
        systemLogs.push("Manual Override: Starting capture...");
        if (systemLogs.length > 3) systemLogs.shift();
    }
}

async function finalizeAndUpload(vncUrl) {
    const wasRecording = isRecording;
    isRecording = false;

    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        systemLogs.push(wasRecording ? "Stopping capture, finalizing segments..." : "Stopping session...");
        if (systemLogs.length > 3) systemLogs.shift();

        if (wasRecording) await recorder.stopRecording();

        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                processedSegments.add(file);
                const filePath = path.join(chunksDir, file);
                targetProgress = Math.min(95, targetProgress + 10);
                systemLogs.push(`Processing final part ${processedSegments.size}...`);
                if (systemLogs.length > 3) systemLogs.shift();
                const audioPath = path.join(outputDir, `${file}.wav`);
                const audioExtracted = await recorder.extractAudio(filePath, audioPath);
                if (audioExtracted) {
                    const transcriptPath = await transcriber.transcribe(audioPath);
                    if (transcriptPath && fs.existsSync(transcriptPath)) {
                        const text = fs.readFileSync(transcriptPath, 'utf8');
                        const cleanText = text.replace(/━━━━━━━━━━━━━━━━━━━━━━\n/g, '').replace(/✨ GHOST meet \| AI TRANSCRIPTION.*\n/g, '').trim();
                        if (cleanText) fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                    }
                }
                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${processedSegments.size}`
                }).catch(() => {});
            }
        }

        if (fs.existsSync(masterTranscriptPath)) {
            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(masterTranscriptPath), filename: 'GHOST_meet_Full_Transcript.txt' }, {
                caption: "📜 *Full AI Meeting Transcript File*", parse_mode: 'Markdown'
            }).catch(() => {});
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
        const customDisplayName = process.env.DISPLAY_NAME || null;
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl}`);
        progressStatus = 'DEPLOYING';
        targetProgress = 20;
        const tunnel = await browserManager.launchMeeting(meetingUrl, customDisplayName);
        vncUrlGlobal = tunnel.url;
        activeParticipantName = tunnel.participantName;
        const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
        axios.get(`${botHost}/register_vnc?vncUrl=${encodeURIComponent(vncUrlGlobal)}`).catch(() => {});
        targetProgress = 100;
        visualProgress = 100;
        progressStatus = scheduledStart ? 'SCHEDULED' : 'READY';
        systemLogs.push(`Identity: ${activeParticipantName}`);
        if (scheduledStart) systemLogs.push(`Schedule Active: ${scheduledStart} - ${scheduledEnd}`);
        else systemLogs.push("Visual engine online.");
        if (systemLogs.length > 3) systemLogs.shift();
        const expressApp = express();
        expressApp.get('/record', async (req, res) => { await triggerStartRecording(); res.json({ success: true }); });
        expressApp.get('/stop', async (req, res) => { res.json({ success: true }); await finalizeAndUpload(vncUrlGlobal); });
        expressApp.listen(8088);
    } catch (error) {
        console.error("Runner Error:", error);
        process.exit(1);
    }
}

run();

async function reportError(err) {
    const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined,
            errorUI.text + `\n\n🚨 *System Failure:* ${err.message || err}`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

process.on('uncaughtException', async (err) => { await reportError(err); process.exit(1); });
process.on('unhandledRejection', async (reason) => { await reportError(reason); process.exit(1); });
