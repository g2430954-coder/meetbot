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

// Throttling for Telegram
let lastUIUpdate = 0;
const UI_UPDATE_INTERVAL = 4000; // 4s prevents Telegram 429 rate limit

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
        participantName: activeParticipantName,
        timer: getTimerString(),
        logs: systemLogs
    });

    try {
        await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, currentUI.text, {
            parse_mode: 'Markdown', ...currentUI.markup
        });
    } catch (e) {
        if (e.description && e.description.includes("message is not modified")) return;
        if (e.description && e.description.includes("Too Many Requests")) {
            const waitSec = (parseInt(e.description.match(/\d+/)?.[0]) || 5) + 1;
            console.warn(`Telegram 429 Rate Limit in runner. Backing off ${waitSec}s...`);
            lastUIUpdate = Date.now() + (waitSec * 1000);
            return;
        }
        console.warn("UI Push throttled by Telegram.");
    }
}, 1000); // Check every 500ms, but only push if 2.5s passed

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

async function getBotHostSignal() {
    try {
        const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
        const res = await axios.get(`${botHost}/get_signal`, { timeout: 2500 });
        return res.data ? res.data.signal : null;
    } catch (e) {
        return null;
    }
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
                    if (cleanText) {
                        fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                    }

                    const lines = text.split('\n').filter(l => l.trim() && !l.includes('━━━━') && !l.includes('SYSTEM:'));
                    if (lines.length > 0) {
                        latestTranscript = lines[lines.length - 1].replace(/^\[\d+:\d+\]\s*/, '');
                    }
                }
            }
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
    const wasRecording = isRecording;
    isRecording = false;

    try {
        progressStatus = 'FINALIZING';
        targetProgress = 40;
        systemLogs.push(wasRecording ? "Stopping capture, finalizing segments..." : "Stopping session...");
        if (systemLogs.length > 3) systemLogs.shift();

        if (wasRecording) {
            await recorder.stopRecording();
        }

        const allFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.mp4')).sort();
        for (const file of allFiles) {
            if (!processedSegments.has(file)) {
                processedSegments.add(file);
                const filePath = path.join(chunksDir, file);
                targetProgress = Math.min(95, targetProgress + 10);
                systemLogs.push(`Processing & uploading final part ${processedSegments.size}...`);
                if (systemLogs.length > 3) systemLogs.shift();

                // Transcribe final segment before upload
                const audioPath = path.join(outputDir, `${file}.wav`);
                const audioExtracted = await recorder.extractAudio(filePath, audioPath);
                if (audioExtracted) {
                    const transcriptPath = await transcriber.transcribe(audioPath);
                    if (transcriptPath && fs.existsSync(transcriptPath)) {
                        const text = fs.readFileSync(transcriptPath, 'utf8');
                        const cleanText = text.replace(/━━━━━━━━━━━━━━━━━━━━━━\n/g, '').replace(/✨ GHOST meet \| AI TRANSCRIPTION.*\n/g, '').trim();
                        if (cleanText) {
                            fs.appendFileSync(masterTranscriptPath, cleanText + "\n");
                        }
                    }
                }

                await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(filePath) }, {
                    caption: `🎥 GHOST meet Recording | Final Part ${processedSegments.size}`
                }).catch(() => {});
            }
        }

        if (fs.existsSync(masterTranscriptPath)) {
            const transcriptContent = fs.readFileSync(masterTranscriptPath, 'utf8').trim();
            if (!transcriptContent || transcriptContent.endsWith("━━━━━━━━━━━━━━━━━━━━━━")) {
                fs.appendFileSync(masterTranscriptPath, "\n\n[SYSTEM: No speech or audio detected during this session.]\n");
            }

            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(masterTranscriptPath), filename: 'GHOST_meet_Full_Transcript.txt' }, {
                caption: "📜 *Full AI Class / Meeting Transcript File*",
                parse_mode: 'Markdown'
            }).catch(e => console.error("Transcript upload error:", e.message));
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
        const customDisplayName = process.env.DISPLAY_NAME || process.env.BOT_DISPLAY_NAME || null;
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl} (Custom Name: ${customDisplayName || 'Random Human'})`);
        progressStatus = 'DEPLOYING';
        targetProgress = 20;

        const tunnel = await browserManager.launchMeeting(meetingUrl, customDisplayName);
        vncUrlGlobal = tunnel.url;
        activeParticipantName = tunnel.participantName;

        // Register active VNC tunnel URL with Telegram bot on Render
        const botHost = process.env.BOT_SERVER_URL || 'https://ghost-meet.onrender.com';
        axios.get(`${botHost}/register_vnc?vncUrl=${encodeURIComponent(vncUrlGlobal)}`).then(() => {
            console.log(`✅ Successfully registered VNC URL with bot server.`);
        }).catch(e => console.warn(`VNC URL registration notice: ${e.message}`));

        targetProgress = 100;
        visualProgress = 100;
        progressStatus = 'READY';
        systemLogs.push(`Identity set: ${activeParticipantName}`);
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

        // Intercept vnc.html to inject Mobile Cyber-Control Overlay
        expressApp.get(['/vnc.html', '/vnc_lite.html'], (req, res) => {
            const proxyReq = http.request({
                host: '127.0.0.1',
                port: 6081,
                path: req.url,
                method: 'GET',
                headers: req.headers
            }, (proxyRes) => {
                let body = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', (chunk) => body += chunk);
                proxyRes.on('end', () => {
                    const mobileOverlayHTML = `
<!-- GHOST MEET MOBILE CYBER CONTROLS (Client-Side Only: Never recorded in video) -->
<style>
  #ghost-mobile-control-bar {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(10, 15, 25, 0.88);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(0, 255, 170, 0.4);
    border-radius: 30px;
    padding: 6px 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    user-select: none;
    touch-action: manipulation;
    font-family: system-ui, -apple-system, sans-serif;
    transition: all 0.3s ease;
  }
  #ghost-mobile-control-bar.collapsed .ghost-btn-full {
    display: none !important;
  }
  .ghost-mob-btn {
    background: linear-gradient(135deg, #00ffaa, #00bfff);
    color: #000;
    border: none;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 800;
    padding: 6px 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    box-shadow: 0 0 10px rgba(0, 255, 170, 0.3);
  }
  .ghost-mob-btn:active {
    transform: scale(0.95);
  }
  .ghost-mob-btn-icon {
    background: rgba(255, 255, 255, 0.15);
    color: #00ffaa;
    border: 1px solid rgba(0, 255, 170, 0.4);
    border-radius: 50%;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    cursor: pointer;
  }
  #ghost-hidden-input {
    position: fixed;
    opacity: 0;
    top: -9999px;
    left: -9999px;
    width: 1px;
    height: 1px;
  }
</style>

<div id="ghost-mobile-control-bar">
  <button class="ghost-mob-btn-icon" id="ghost-toggle-bar" title="Toggle Controls">⚙️ Controls</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-zoom-in">🔍 Zoom In (+)</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-zoom-out">🔍 Zoom Out (-)</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-zoom-fit">🔄 Normal (Reset)</button>
  <button class="ghost-mob-btn ghost-btn-full" id="ghost-keyboard">⌨️ Phone Keybd</button>
</div>
<input type="text" id="ghost-hidden-input" autocomplete="off" autocorrect="off" autocapitalize="off">

<script>
(function() {
  let currentScale = 0.8;
  const bar = document.getElementById('ghost-mobile-control-bar');
  const toggleBtn = document.getElementById('ghost-toggle-bar');
  const zoomInBtn = document.getElementById('ghost-zoom-in');
  const zoomOutBtn = document.getElementById('ghost-zoom-out');
  const zoomFitBtn = document.getElementById('ghost-zoom-fit');
  const kbdBtn = document.getElementById('ghost-keyboard');
  const hiddenInput = document.getElementById('ghost-hidden-input');

  if (toggleBtn) toggleBtn.addEventListener('click', () => bar.classList.toggle('collapsed'));

  function applyScale(scale) {
    currentScale = Math.max(0.4, Math.min(3.0, scale));
    const canvas = document.querySelector('canvas') || document.getElementById('noVNC_canvas');
    if (canvas) {
      canvas.style.transform = 'scale(' + currentScale + ')';
      canvas.style.transformOrigin = 'top left';
    }
  }

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => applyScale(currentScale + 0.3));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => applyScale(currentScale - 0.3));
  if (zoomFitBtn) zoomFitBtn.addEventListener('click', () => applyScale(0.8));

  if (kbdBtn && hiddenInput) {
    kbdBtn.addEventListener('click', () => {
      hiddenInput.focus();
    });

    hiddenInput.addEventListener('input', (e) => {
      const char = e.data;
      if (char && window.UI && window.UI.rfb) {
        for (let i = 0; i < char.length; i++) {
          const code = char.charCodeAt(i);
          window.UI.rfb.sendKey(code, true);
          window.UI.rfb.sendKey(code, false);
        }
      }
      hiddenInput.value = '';
    });
  }
})();
</script>
`;
                    const modifiedBody = body.includes('</body>') ? body.replace('</body>', mobileOverlayHTML + '</body>') : body + mobileOverlayHTML;
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(modifiedBody);
                });
            });

            proxyReq.on('error', () => {
                if (!res.headersSent) res.status(502).send("Visual Bridge Initializing...");
            });

            proxyReq.end();
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
