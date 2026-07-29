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
let isProcessingSegment = false; // LOCK to prevent overlap
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

function parseTimeToToday(timeStr) {
    if (!timeStr) return null;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
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
    }
}, 1000);

function getTimerString() {
    if (!recordingStartTime || !isRecording) return null;
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    return formatTime(elapsed);
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

async function processLatestSegments() {
    if (!fs.existsSync(chunksDir) || isProcessingSegment) return;

    const files = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();

    // A segment is considered "finished" if a LATER segment exists
    for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        if (!processedSegments.has(file)) {
            isProcessingSegment = true;
            try {
                const partNum = processedSegments.size + 1;
                const filePath = path.join(chunksDir, file);

                console.log(`📦 Real-Time Processing: ${file}`);
                systemLogs.push(`Processing Part ${partNum}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                // 1. Extract Audio & Transcribe
                let segmentText = "No speech detected in this segment.";
                const audioPath = path.join(outputDir, `${file}.wav`);
                const audioExtracted = await recorder.extractAudio(filePath, audioPath);

                if (audioExtracted) {
                    const transcriptPath = await transcriber.transcribe(audioPath);
                    if (transcriptPath && fs.existsSync(transcriptPath)) {
                        const text = fs.readFileSync(transcriptPath, 'utf8');
                        const cleanText = text.replace(/━━━━━━━━━━━━━━━━━━━━━━\n/g, '').replace(/✨ GHOST meet \| AI TRANSCRIPTION.*\n/g, '').trim();
                        if (cleanText) {
                            fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                            segmentText = cleanText;
                        }
                        const lines = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:'));
                        if (lines.length > 0) latestTranscript = lines[lines.length - 1].replace(/^\[\d+:\d+\]\s*/, '');
                    }
                }

                // 2. Upload Video Part to Telegram
                systemLogs.push(`Uploading Part ${partNum}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Part ${partNum}\n📜 Text: ${segmentText.substring(0, 800)}...`
                });

                processedSegments.add(file);
                systemLogs.push(`Part ${partNum} secured.`);
                if (systemLogs.length > 3) systemLogs.shift();

                // Cleanup temporary audio
                if (fs.existsSync(audioPath)) fs.removeSync(audioPath);

            } catch (e) {
                console.error(`Error processing segment ${file}:`, e.message);
                await bot.telegram.sendMessage(chatId, `🚨 *Upload Warning:* Failed to process Part ${processedSegments.size + 1}. System will retry later.`, { parse_mode: 'Markdown' }).catch(() => {});
            } finally {
                isProcessingSegment = false;
            }
        }
    }
}

const backgroundTaskInterval = setInterval(async () => {
    const now = new Date();
    const startTime = parseTimeToToday(scheduledStart);
    const endTime = parseTimeToToday(scheduledEnd);
    if (isRecording) {
        const shouldStop = await checkStopSignal();
        const isPastEndTime = endTime && now >= endTime;
        if (shouldStop || isPastEndTime) {
            if (isPastEndTime) systemLogs.push("Auto-Stop: Schedule completed.");
            await finalizeAndUpload(vncUrlGlobal);
        } else {
            await processLatestSegments();
        }
    } else {
        const recordSignal = await checkRecordSignal();
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
        systemLogs.push("Signal received: Recording started.");
        if (systemLogs.length > 3) systemLogs.shift();
    }
}

async function finalizeAndUpload(vncUrl) {
    const wasRecording = isRecording;
    isRecording = false;

    // Wait if a segment is currently being processed
    for (let i = 0; i < 20; i++) {
        if (!isProcessingSegment) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    isProcessingSegment = true;

    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        systemLogs.push(wasRecording ? "Terminating capture engine..." : "Finalizing session...");
        if (systemLogs.length > 3) systemLogs.shift();

        if (wasRecording) await recorder.stopRecording();

        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                const partNum = processedSegments.size + 1;
                const filePath = path.join(chunksDir, file);
                targetProgress = Math.min(95, targetProgress + 10);

                systemLogs.push(`Processing Final Part ${partNum}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                // Transcribe final segment before upload
                let segmentText = "No speech detected in this final segment.";
                const audioPath = path.join(outputDir, `${file}.wav`);
                const audioExtracted = await recorder.extractAudio(filePath, audioPath);
                if (audioExtracted) {
                    const transcriptPath = await transcriber.transcribe(audioPath);
                    if (transcriptPath && fs.existsSync(transcriptPath)) {
                        const text = fs.readFileSync(transcriptPath, 'utf8');
                        const cleanText = text.replace(/━━━━━━━━━━━━━━━━━━━━━━\n/g, '').replace(/✨ GHOST meet \| AI TRANSCRIPTION.*\n/g, '').trim();
                        if (cleanText) {
                            fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                            segmentText = cleanText;
                        }
                    }
                }

                systemLogs.push(`Uploading Part ${partNum}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${partNum}\n📜 Text: ${segmentText.substring(0, 800)}...`
                }).catch(() => {});

                processedSegments.add(file);
                if (fs.existsSync(audioPath)) fs.removeSync(audioPath);
            }
        }

        if (fs.existsSync(masterTranscriptPath)) {
            systemLogs.push("Sending full transcript...");
            if (systemLogs.length > 3) systemLogs.shift();
            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(masterTranscriptPath), filename: 'GHOST_meet_Full_Transcript.txt' }, {
                caption: "📜 *Full AI Meeting Transcript File*", parse_mode: 'Markdown'
            }).catch(() => {});
        }

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'COMPLETED';
        systemLogs.push("Mission successful. Engine offline.");
        if (systemLogs.length > 3) systemLogs.shift();

        setTimeout(() => {
            clearInterval(masterUIInterval);
            clearInterval(backgroundTaskInterval);
            process.exit(0);
        }, 10000);

    } catch (err) {
        console.error("Finalize Error:", err);
        isProcessingSegment = false;
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
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl} (Custom Name: ${customDisplayName || 'Random Human'})`);

        // 1. START CONTROL BRIDGE IMMEDIATELY (Fixes 502 Bad Gateway)
        const http = require('http');
        const expressApp = express();
        expressApp.get('/bridge_health', (req, res) => res.json({ status: 'active', timestamp: Date.now() }));
        expressApp.get('/record', async (req, res) => {
            console.log("⚡ DIRECT TUNNEL HTTP SIGNAL: START RECORDING!");
            systemLogs.push("Signal received: Recording engaged.");
            if (systemLogs.length > 3) systemLogs.shift();
            await triggerStartRecording();
            res.json({ status: 'recording', success: true });
        });
        expressApp.get('/stop', async (req, res) => {
            console.log("⚡ DIRECT TUNNEL HTTP SIGNAL: STOP RECORDING!");
            systemLogs.push("Signal received: Session termination.");
            if (systemLogs.length > 3) systemLogs.shift();
            res.json({ status: 'finalizing', success: true });
            await finalizeAndUpload(vncUrlGlobal);
        });
        expressApp.get('/status', (req, res) => res.json({ isRecording, progressStatus }));
        expressApp.get(['/vnc.html', '/vnc_lite.html'], (req, res) => {
            const proxyReq = http.request({ host: '127.0.0.1', port: 6081, path: req.url, method: 'GET', headers: req.headers }, (proxyRes) => {
                let body = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', (chunk) => body += chunk);
                proxyRes.on('end', () => {
                    const mobileOverlayHTML = `
<!-- GHOST MEET MOBILE CYBER CONTROLS -->
<style>
  #ghost-mobile-control-bar { position: fixed; top: 12px; right: 12px; z-index: 999999; display: flex; align-items: center; gap: 6px; background: rgba(10, 15, 25, 0.88); backdrop-filter: blur(12px); border: 1px solid rgba(0, 255, 170, 0.4); border-radius: 30px; padding: 6px 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); touch-action: manipulation; font-family: sans-serif; transition: all 0.3s ease; }
  #ghost-mobile-control-bar.collapsed { padding: 4px; border-radius: 50%; }
  #ghost-mobile-control-bar.collapsed .ghost-btn-full { display: none !important; }
  .ghost-mob-btn { background: linear-gradient(135deg, #00ffaa, #00bfff); color: #000; border: none; border-radius: 20px; font-size: 12px; font-weight: 800; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
  .ghost-mob-btn-icon { background: rgba(255, 255, 255, 0.15); color: #00ffaa; border: 1px solid rgba(0, 255, 170, 0.4); border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  canvas { max-width: 100vw !important; height: auto !important; object-fit: contain !important; }
</style>
<div id="ghost-mobile-control-bar" class="collapsed">
  <button class="ghost-mob-btn-icon" id="ghost-toggle-bar">⚙️</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-zoom-fit">🔍 Fit Screen</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-keyboard">⌨️ Kbd</button>
</div>
<script>
  const bar = document.getElementById('ghost-mobile-control-bar');
  document.getElementById('ghost-toggle-bar').onclick = () => bar.classList.toggle('collapsed');
  document.getElementById('ghost-zoom-fit').onclick = () => {
      const canvas = document.querySelector('canvas') || document.getElementById('noVNC_canvas');
      if (canvas) {
          canvas.style.width = '100vw';
          canvas.style.height = 'auto';
      }
  };
</script>`;
                    const modifiedBody = body.includes('</body>') ? body.replace('</body>', mobileOverlayHTML + '</body>') : body + mobileOverlayHTML;
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(modifiedBody);
                });
            });
            proxyReq.on('error', () => res.status(502).send("Bridge Syncing..."));
            proxyReq.end();
        });
        expressApp.use((req, res) => {
            const proxyReq = http.request({ host: '127.0.0.1', port: 6081, path: req.url, method: req.method, headers: req.headers }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res, { end: true });
            });
            proxyReq.on('error', () => res.status(502).send("Bridge Syncing..."));
            req.pipe(proxyReq, { end: true });
        });
        const controlServer = expressApp.listen(6080, () => { console.log("🚀 Express Control Bridge active on port 6080"); });
        controlServer.on('upgrade', (req, socket, head) => {
            const proxyReq = http.request({ host: '127.0.0.1', port: 6081, path: req.url, method: req.method, headers: req.headers });
            proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
                socket.write(`HTTP/1.1 101 Switching Protocols\r\n` + Object.keys(proxyRes.headers).map(k => `${k}: ${proxyRes.headers[k]}`).join('\r\n') + '\r\n\r\n');
                proxySocket.pipe(socket);
                socket.pipe(proxySocket);
            });
            proxyReq.on('error', () => socket.destroy());
            proxyReq.end();
        });

        // 2. NOW LAUNCH BROWSER & TUNNEL
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
        if (scheduledStart) systemLogs.push(`Schedule: ${scheduledStart} - ${scheduledEnd}`);
        else systemLogs.push("Visual engine online.");
        if (systemLogs.length > 3) systemLogs.shift();
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
