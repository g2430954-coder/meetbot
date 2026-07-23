const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const browserManager = require('../src/core/browser');
const recorder = require('../src/core/recorder');
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
let heartbeatInterval = null;
let recordingStartTime = null;
const runnerStartTime = Date.now();

// Use built-in chrome on GitHub
process.env.CHROME_PATH = '/usr/bin/google-chrome-stable';

/**
 * Check if a record_ghost_runner dispatch event was sent to GitHub API
 */
async function checkRecordSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
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
                if (ev.type === 'RepositoryDispatchEvent' && ev.payload && ev.payload.action === 'record_ghost_runner') {
                    const eventTime = new Date(ev.created_at).getTime();
                    if (eventTime >= runnerStartTime - 5000) {
                        console.log("🔴 Record signal detected from GitHub Dispatch!");
                        return true;
                    }
                }
            }
        }
    } catch (e) {
        // Silent catch
    }
    return false;
}

/**
 * Check if a stop_ghost_runner dispatch event was sent to GitHub API
 */
async function checkStopSignal() {
    try {
        const token = process.env.PAT_TOKEN || process.env.GITHUB_TOKEN;
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
            meetingUrl: meetingUrl,
            vncUrl: vncUrl
        });

        try {
            await bot.telegram.editMessageText(chatId, Number(playerMessageId), undefined, updatedUI.text, {
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
        const msgId = Number(playerMessageId);

        // Phase 1: Stop FFMPEG
        const finalizingUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 15, meetingUrl: meetingUrl, vncUrl: vncUrl });
        await bot.telegram.editMessageText(chatId, msgId, undefined, finalizingUI.text, { parse_mode: 'Markdown', ...finalizingUI.markup }).catch(() => {});

        const stopPromise = recorder.stopRecording();

        // Phase 2: Processing & STT
        const processingUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 40, meetingUrl: meetingUrl, vncUrl: vncUrl });
        await bot.telegram.editMessageText(chatId, msgId, undefined, processingUI.text, { parse_mode: 'Markdown', ...processingUI.markup }).catch(() => {});

        const assets = await stopPromise;
        const totalChunks = assets.videoChunks.length;

        // Phase 3: Uploading Video Segments
        for (let i = 0; i < totalChunks; i++) {
            const uploadProgress = Math.round(50 + ((i + 1) / (totalChunks + 1)) * 40);
            const uploadingUI = ui.generatePlayerUI({ 
                status: 'FINALIZING', 
                progress: uploadProgress, 
                meetingUrl: meetingUrl, 
                vncUrl: vncUrl 
            });
            await bot.telegram.editMessageText(chatId, msgId, undefined, uploadingUI.text, { parse_mode: 'Markdown', ...uploadingUI.markup }).catch(() => {});

            await bot.telegram.sendVideo(chatId, { source: fs.createReadStream(assets.videoChunks[i]) }, { 
                caption: `🎥 GHOST meet Recording | Part ${i+1} of ${totalChunks}` 
            });
        }

        // Phase 4: Uploading AI Transcript
        if (assets.transcriptPath) {
            const transcriptUI = ui.generatePlayerUI({ status: 'FINALIZING', progress: 95, meetingUrl: meetingUrl, vncUrl: vncUrl });
            await bot.telegram.editMessageText(chatId, msgId, undefined, transcriptUI.text, { parse_mode: 'Markdown', ...transcriptUI.markup }).catch(() => {});

            await bot.telegram.sendDocument(chatId, { source: fs.createReadStream(assets.transcriptPath), filename: 'GHOST_meet_Transcript.txt' }, { 
                caption: "📜 *AI Meeting Transcript (100% English Output)*", 
                parse_mode: 'Markdown' 
            });
        }

        // Phase 5: Complete State
        const completedUI = ui.generatePlayerUI({ status: 'COMPLETED', progress: 100, partCount: totalChunks, meetingUrl: meetingUrl, vncUrl: vncUrl });
        await bot.telegram.editMessageText(chatId, msgId, undefined, completedUI.text, { parse_mode: 'Markdown', ...completedUI.markup }).catch(() => {});

        setTimeout(() => {
            console.log("GHOST Runner completed successfully. Exiting.");
            process.exit(0);
        }, 5000);

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

        const msgId = Number(playerMessageId);

        // Start continuous real-time progress streamer on Telegram starting from 5%
        let deployPercent = 5;
        const deployTimer = setInterval(async () => {
            if (deployPercent < 98) {
                deployPercent += Math.floor(Math.random() * 4) + 2; // Increments +2% to +5% smoothly
                if (deployPercent > 98) deployPercent = 98;

                const logMsg = getWorkflowStepLog(deployPercent);
                const deployUI = ui.generatePlayerUI({
                    status: 'DEPLOYING',
                    progress: deployPercent,
                    meetingUrl: meetingUrl,
                    stepLog: logMsg
                });

                await bot.telegram.editMessageText(chatId, msgId, undefined, deployUI.text, {
                    parse_mode: 'Markdown', ...deployUI.markup
                }).catch(() => {});
            }
        }, 1200);

        // Launch Browser & Serveo Tunnel
        const tunnel = await browserManager.launchMeeting(meetingUrl);

        // Stop continuous streamer
        clearInterval(deployTimer);

        // Update Telegram Message to 100% READY Standby State with RDP Link & START RECORDING button
        const readyUI = ui.generatePlayerUI({ 
            status: 'READY', 
            progress: 100, 
            meetingUrl: meetingUrl, 
            vncUrl: tunnel.url,
            stepLog: '✨ System Standby (100% Ready). Tap button below or send /record to start.'
        });
        await bot.telegram.editMessageText(chatId, msgId, undefined, readyUI.text, {
            parse_mode: 'Markdown', ...readyUI.markup
        }).catch((err) => console.error("Initial Ready UI edit error:", err.message));

        // 3. Express HTTP control server for Render bot commands
        const app = express();

        async function triggerStartRecording() {
            if (!isRecording) {
                console.log("🔴 Starting HD Stream Recording...");
                await recorder.startRecording();
                isRecording = true;
                startHeartbeat(tunnel.url);
            }
        }

        app.get('/record', async (req, res) => {
            res.json({ status: 'recording' });
            triggerStartRecording();
        });

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

        // 4. Poll for record start signal from GitHub Dispatch
        const checkRecordInterval = setInterval(async () => {
            if (isRecording) {
                clearInterval(checkRecordInterval);
                return;
            }
            const recordSignal = await checkRecordSignal();
            if (recordSignal && !isRecording) {
                clearInterval(checkRecordInterval);
                await triggerStartRecording();
            }
        }, 3000);

    } catch (error) {
        console.error("Runner Execution Error:", error);
        process.exit(1);
    }
}

run();
