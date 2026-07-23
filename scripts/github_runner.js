const { Telegraf } = require('telegraf');
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const browserManager = require('../src/core/browser');
const recorder = require('../src/core/recorder');
const logger = require('../utils/logger');
const ui = require('../utils/ui');

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

async function run() {
    try {
        console.log(`🚀 Launching GHOST Runner for URL: ${meetingUrl}`);

        const msgId = Number(playerMessageId);

        // Step 1: Mounting 1080p Virtual Display (35%)
        const step1UI = ui.generatePlayerUI({ status: 'DEPLOYING', progress: 35, meetingUrl: meetingUrl });
        await bot.telegram.editMessageText(chatId, msgId, undefined, step1UI.text, { parse_mode: 'Markdown', ...step1UI.markup }).catch(() => {});

        // Step 2: Launch Stealth Browser & Serveo VNC Tunnel (65%)
        const step2UI = ui.generatePlayerUI({ status: 'DEPLOYING', progress: 65, meetingUrl: meetingUrl });
        await bot.telegram.editMessageText(chatId, msgId, undefined, step2UI.text, { parse_mode: 'Markdown', ...step2UI.markup }).catch(() => {});

        const tunnel = await browserManager.launchMeeting(meetingUrl);

        // Step 3: Audio & Room Connected (85%)
        const step3UI = ui.generatePlayerUI({ status: 'DEPLOYING', progress: 85, meetingUrl: meetingUrl, vncUrl: tunnel.url });
        await bot.telegram.editMessageText(chatId, msgId, undefined, step3UI.text, { parse_mode: 'Markdown', ...step3UI.markup }).catch(() => {});

        // Step 4: Update Telegram Message to 100% READY Standby State with START RECORDING button & RDP Link
        const readyUI = ui.generatePlayerUI({ status: 'READY', progress: 100, meetingUrl: meetingUrl, vncUrl: tunnel.url });
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
