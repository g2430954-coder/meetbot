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
    } catch (e) {
        return null;
    }
}

async function checkRecordSignal() {
    const sig = await getGhostSignal();
    return sig === 'RECORD';
}

async function checkStopSignal() {
    const sig = await getGhostSignal();
    return sig === 'STOP';
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
    if (isRecording) {
        const shouldStop = await checkStopSignal();
        if (shouldStop) {
            await finalizeAndUpload(vncUrlGlobal);
        } else {
            await processLatestSegments();
        }
    } else {
        // Check for record signal
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
        systemLogs.push("Visual engine online. Click START CAPTURE to record.");
        if (systemLogs.length > 3) systemLogs.shift();

        const http = require('http');
        const expressApp = express();

        expressApp.get('/record', async (req, res) => {
            console.log("⚡ DIRECT TUNNEL HTTP SIGNAL: START RECORDING!");
            await triggerStartRecording();
            res.json({ status: 'recording', success: true });
        });

        expressApp.get('/stop', async (req, res) => {
            console.log("⚡ DIRECT TUNNEL HTTP SIGNAL: STOP RECORDING!");
            res.json({ status: 'finalizing', success: true });
            await finalizeAndUpload(vncUrlGlobal);
        });

        expressApp.get('/status', (req, res) => {
            res.json({ isRecording, progressStatus });
        });

        // Proxy all other HTTP traffic to NoVNC on 6081
        expressApp.use((req, res) => {
            const proxyReq = http.request({
                host: '127.0.0.1',
                port: 6081,
                path: req.url,
                method: req.method,
                headers: req.headers
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res, { end: true });
            });

            proxyReq.on('error', () => {
                if (!res.headersSent) res.status(502).send("Visual Bridge Initializing...");
            });

            req.pipe(proxyReq, { end: true });
        });

        const controlServer = expressApp.listen(6080, () => {
            console.log("🚀 Express Control Bridge listening on port 6080");
        });

        // Proxy WebSockets for NoVNC
        controlServer.on('upgrade', (req, socket, head) => {
            const proxyReq = http.request({
                host: '127.0.0.1',
                port: 6081,
                path: req.url,
                method: req.method,
                headers: req.headers
            });

            proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
                socket.write(`HTTP/1.1 101 Switching Protocols\r\n` +
                    Object.keys(proxyRes.headers).map(k => `${k}: ${proxyRes.headers[k]}`).join('\r\n') + '\r\n\r\n');
                proxySocket.pipe(socket);
                socket.pipe(proxySocket);
            });

            proxyReq.on('error', () => socket.destroy());
            proxyReq.end();
        });

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
