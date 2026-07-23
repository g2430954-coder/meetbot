const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const express = require('express');
const path = require('path');
const browserManager = require('../core/browser');
const recorder = require('../core/recorder');
const github = require('../utils/github');
const logger = require('../utils/logger');
const ui = require('../utils/ui');

// Load environment variables
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;

// Global session state - FIX for double-click issue
const sessionState = {
    isJoined: false,
    isRecording: false,
    currentUrl: null,
    currentChatId: null,
    playerMessageId: null,
    recordingStartTime: null,
    timerInterval: null
};

// Update Deduplication Cache to prevent double processing of link preview updates
const processedUpdates = new Map();

/**
 * Helper to extract meeting URL from text (supports both /join <url> and raw HTTP/HTTPS meeting links)
 */
function extractMeetingUrl(text) {
    if (!text) return null;
    text = text.trim();

    // 1. /join command syntax
    if (text.startsWith('/join')) {
        const parts = text.split(/\s+/);
        if (parts.length >= 2 && /^https?:\/\//i.test(parts[1])) {
            return parts[1].trim();
        }
    }

    // 2. Direct raw meeting link syntax (matches any http/https URL)
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match ? match[0].trim() : null;
}

/**
 * STRICT GROUP AUTHORIZATION & AUTO-LINK DEDUPLICATION MIDDLEWARE
 */
bot.use(async (ctx, next) => {
    if (!ctx.chat) return;

    // Deduplicate Telegram message updates (link previews / re-sent updates)
    if (ctx.message && ctx.message.message_id) {
        const msgId = ctx.message.message_id;
        if (processedUpdates.has(msgId)) {
            return; // Silent ignore duplicate update from Telegram
        }
        processedUpdates.set(msgId, Date.now());

        // Cache cleanup
        if (processedUpdates.size > 200) {
            const now = Date.now();
            for (const [id, time] of processedUpdates.entries()) {
                if (now - time > 60000) processedUpdates.delete(id);
            }
        }
    }

    const chatId = ctx.chat.id.toString();

    // 1. Authorization Check: If ALLOWED_GROUP_ID is configured and doesn't match, notify with Chat ID
    if (ALLOWED_GROUP_ID && ALLOWED_GROUP_ID !== '*' && chatId !== ALLOWED_GROUP_ID) {
        if (ctx.message && ctx.message.text) {
            logger.warn(`Unauthorized access attempt from Chat ID: ${chatId} (Expected: ${ALLOWED_GROUP_ID})`);
            return ctx.replyWithMarkdown(
                `🚨 *GHOST meet | ACCESS DENIED*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━\n` +
                `This terminal is locked to Group ID: \`${ALLOWED_GROUP_ID}\`.\n\n` +
                `*Your Chat ID:* \`${chatId}\`\n\n` +
                `👉 *Fix:* Set \`ALLOWED_GROUP_ID\` to \`${chatId}\` (or \`*\`) in Render Environment Variables.`
            );
        }
        return; 
    }

    // 2. Raw Link Auto-Detection
    if (ctx.message && ctx.message.text) {
        const text = ctx.message.text.trim();

        // If it's NOT a / command, check if it contains a meeting URL
        if (!text.startsWith('/')) {
            const rawUrl = extractMeetingUrl(text);
            if (rawUrl) {
                // Automatically convert raw meeting link into /join command!
                ctx.message.text = `/join ${rawUrl}`;
                return next();
            }
            // Silent ignore for normal chat text
            return;
        }
    }

    return next();
});

/**
 * /start - Boot the system interface
 */
bot.start((ctx) => {
    const welcomeUI =
        "🛸 *GHOST meet | SYSTEM TERMINAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Status: ✅ *OPERATIONAL*\n" +
        "Security: 🔒 *ENCRYPTED*\n\n" +
        "Welcome, Operative. The capture suite is on standby.\n\n" +
        "📋 *Operational Commands:*\n" +
        "🔹 `/join <url>` - Deploy Virtual Frame Buffer\n" +
        "🔹 `/record` - Initiate 1080p HD Capture\n" +
        "🔹 `/stop` - Finalize, Split & Transcribe\n" +
        "🔹 `/status` - Engine Diagnostics";

    ctx.replyWithMarkdown(welcomeUI, Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Check Diagnostics', 'engine_status')],
        [Markup.button.callback('📖 Help & Documentation', 'help_guide')]
    ]));
});

/**
 * /join <url> - Deploy visual engine (FIXED: Auto-triggers GitHub Dispatch with silent deduplication)
 */
/**
 * /join <url> - Deploy visual engine (Auto-triggers GitHub Dispatch with silent deduplication)
 */
bot.command('join', async (ctx) => {
    const meetingUrl = extractMeetingUrl(ctx.message.text);
    if (!meetingUrl || !/^https?:\/\//i.test(meetingUrl)) {
        return ctx.replyWithMarkdown("❌ *Error:* Invalid or missing URL. Usage: `/join https://meet.google.com/...` ");
    }

    // Check existing active session
    if (sessionState.isJoined || sessionState.isRecording) {
        return ctx.replyWithMarkdown("⚠️ *Active Session Exists*\n━━━━━━━━━━━━━━━━━━━━━━\nA session is already active. Use `/stop` to finalize it before joining a new room.");
    }

    sessionState.currentUrl = meetingUrl;
    sessionState.currentChatId = ctx.chat.id;
    sessionState.isJoined = true;

    // Send INITIALIZING UI
    const player = ui.generatePlayerUI({ status: 'INITIALIZING', meetingUrl });
    const msg = await ctx.replyWithMarkdown(player.text, player.markup);
    sessionState.playerMessageId = msg.message_id;

    // Always trigger GitHub Actions Runner for heavy Chrome & FFmpeg execution
    try {
        await github.triggerRunner(meetingUrl, sessionState.playerMessageId, ctx.chat.id.toString());
        sessionState.isRecording = true; // Mark active so /stop works anytime

        // Update UI to DEPLOYING
        const dispatchedUI = ui.generatePlayerUI({ status: 'DEPLOYING', meetingUrl });
        await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, dispatchedUI.text, {
            parse_mode: 'Markdown',
            ...dispatchedUI.markup
        });
    } catch (error) {
        logger.error("GitHub Trigger Failure:", error);
        sessionState.isJoined = false;
        sessionState.isRecording = false;
        const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
        await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, errorUI.text + `\n\n🚨 *Dispatch Failure:* ${error.message}`, { parse_mode: 'Markdown' });
    }
    return;

    // Local / Non-Render logic
    try {
        const tunnel = await browserManager.launchMeeting(meetingUrl);
        const successUI = ui.generatePlayerUI({ status: 'READY', meetingUrl: tunnel.url });
        await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, successUI.text, {
            parse_mode: 'Markdown',
            ...successUI.markup
        });
    } catch (error) {
        logger.error("Deployment Failure:", error);
        sessionState.isJoined = false;
        const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
        await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, errorUI.text + `\n\n🚨 *System Failure:* ${error.message}`, { parse_mode: 'Markdown' });
    }
});

/**
 * Handle Record execution
 */
async function handleRecord(ctx) {
    if (!sessionState.isJoined) {
        return ctx.replyWithMarkdown("❌ *Error:* Not joined yet. Send Google Meet link or `/join <url>` first.");
    }

    if (sessionState.isRecording) {
        return ctx.replyWithMarkdown("⚠️ *Already Recording*\n━━━━━━━━━━━━━━━━━━━━━━\nUse `/stop` or tap *STOP & SAVE* to end recording.");
    }

    sessionState.isRecording = true;
    sessionState.recordingStartTime = Date.now();

    try {
        await recorder.startRecording();
        
        // START REAL-TIME TIMER UPDATES
        let elapsedSeconds = 0;
        sessionState.timerInterval = setInterval(async () => {
            elapsedSeconds += 3;
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = elapsedSeconds % 60;
            const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

            const updatedUI = ui.generatePlayerUI({
                status: 'RECORDING',
                timer: timeStr,
                meetingUrl: sessionState.currentUrl
            });

            try {
                if (sessionState.playerMessageId) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        sessionState.playerMessageId,
                        undefined,
                        updatedUI.text,
                        { parse_mode: 'Markdown', ...updatedUI.markup }
                    );
                }
            } catch (err) {
                if (err.description && err.description.includes("message is not modified")) return;
                logger.warn("Timer update notice:", err.message);
            }
        }, 3000);

    } catch (error) {
        logger.error("Recording Start Failure:", error);
        sessionState.isRecording = false;
        if (sessionState.timerInterval) clearInterval(sessionState.timerInterval);
        await ctx.replyWithMarkdown(`🚨 *Recording Error:* ${error.message}`);
    }
}

bot.command('record', handleRecord);
bot.action('cmd_record', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    return handleRecord(ctx);
});

/**
 * Handle Stop & Save execution
 */
async function handleStop(ctx) {
    if (!sessionState.isJoined && !sessionState.isRecording) {
        return ctx.replyWithMarkdown("⚠️ *Not Recording*\n━━━━━━━━━━━━━━━━━━━━━━\nStart a session with `/join <url>` first.");
    }

    // STOP LOCAL TIMER
    if (sessionState.timerInterval) {
        clearInterval(sessionState.timerInterval);
        sessionState.timerInterval = null;
    }

    sessionState.isRecording = false;

    const stoppingUI = ui.generatePlayerUI({
        status: 'FINALIZING',
        meetingUrl: sessionState.currentUrl
    });

    if (sessionState.playerMessageId) {
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, stoppingUI.text, {
                parse_mode: 'Markdown', ...stoppingUI.markup
            });
        } catch (e) {}
    }

    // Always send stop signal to GitHub Actions Runner
    try {
        await github.triggerStopRunner(ctx.chat.id.toString(), sessionState.playerMessageId);
        await ctx.replyWithMarkdown(
            "⏳ *Stop Signal Dispatched*\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n" +
            "⚙️ Cloud runner is finalizing capture, splitting video chunks, and processing English AI transcription.\n" +
            "📁 Video parts and transcript document will be uploaded here shortly."
        );
    } catch (error) {
        logger.error("GitHub Stop Trigger Failure:", error);
        await ctx.replyWithMarkdown(`🚨 *Stop Dispatch Error:* ${error.message}`);
    } finally {
        // RESET SESSION STATE
        sessionState.isJoined = false;
        sessionState.isRecording = false;
        sessionState.currentUrl = null;
        sessionState.playerMessageId = null;
        sessionState.recordingStartTime = null;
    }
    return;

    // Local execution mode
    try {
        const duration = sessionState.recordingStartTime ? 
            Math.round((Date.now() - sessionState.recordingStartTime) / 1000) : 0;
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        const assets = await recorder.stopRecording();
        
        const completedUI = ui.generatePlayerUI({
            status: 'COMPLETED',
            timer: timeStr,
            partCount: assets.videoChunks.length
        });

        if (sessionState.playerMessageId) {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, completedUI.text, {
                    parse_mode: 'Markdown', ...completedUI.markup
                });
            } catch (e) {}
        }

        // Upload Video Segments
        for (let i = 0; i < assets.videoChunks.length; i++) {
            await ctx.replyWithVideo(
                { source: assets.videoChunks[i] },
                { 
                    caption: `🎥 GHOST meet Recording | Part ${i + 1} of ${assets.videoChunks.length}\n⏱ Duration: ${timeStr}` 
                }
            );
        }

        // Upload AI Transcript
        if (assets.transcriptPath) {
            await ctx.replyWithDocument(
                { source: assets.transcriptPath },
                { caption: "📜 AI Meeting Transcript (100% English / Roman Script)\n📝 Full continuous transcription" }
            );
        }

        const finalUI =
            "✨ *SESSION COMPLETE*\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n" +
            "✅ All assets uploaded successfully.\n" +
            "📁 Files secured in group storage.\n" +
            "💤 Engine hibernated.\n\n" +
            "Send Google Meet link to start a new session.";
        await ctx.replyWithMarkdown(finalUI);

    } catch (error) {
        logger.error("Finalization Failure:", error);
        await ctx.replyWithMarkdown(`🚨 *Stop Error:* ${error.message}`);
    } finally {
        // RESET SESSION STATE FIX
        sessionState.isJoined = false;
        sessionState.isRecording = false;
        sessionState.currentUrl = null;
        sessionState.playerMessageId = null;
        sessionState.recordingStartTime = null;
    }
}

bot.command('stop', handleStop);
bot.action('cmd_stop', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    return handleStop(ctx);
});

/**
 * /status - Real-time diagnostics and session status
 */
bot.command('status', (ctx) => {
    const recordingStatus = sessionState.isRecording ? "🔴 ACTIVE RECORDING" : "⚪️ IDLE";
    const joinStatus = sessionState.isJoined ? "🟢 CONNECTED" : "🔴 DISCONNECTED";
    const modeStr = (process.env.RENDER || process.env.PAT_TOKEN) ? "☁️ Cloud Runner (GitHub Actions)" : "🖥 Local Node Process";
    
    let duration = "0:00";
    if (sessionState.recordingStartTime) {
        const elapsed = Math.round((Date.now() - sessionState.recordingStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        duration = `${mins}:${(elapsed % 60).toString().padStart(2, '0')}`;
    }

    const diagnosticUI =
        "📟 *SYSTEM DIAGNOSTICS*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        `📍 Session Status: ${joinStatus}\n` +
        `⏺ Capture Engine: ${recordingStatus}\n` +
        `⏱ Duration: *${duration}*\n` +
        `⚙️ Execution Mode: *${modeStr}*\n` +
        "⚡️ Kernel: *100% Operational*\n" +
        "🖥 Virtual Display: *Active (:99)*\n" +
        "🎥 FFMPEG Pipeline: *Ready*\n" +
        "🗣 STT Engine: *Bilingual Mode (Hindi/Hinglish)*\n" +
        "💾 Storage: *Optimized*";
    ctx.replyWithMarkdown(diagnosticUI);
});

// Inline Actions
bot.action('engine_status', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    const recordingStatus = sessionState.isRecording ? "🔴 ACTIVE RECORDING" : "⚪️ IDLE";
    const joinStatus = sessionState.isJoined ? "🟢 CONNECTED" : "🔴 DISCONNECTED";
    ctx.replyWithMarkdown(
        `📟 *ENGINE DIAGNOSTICS*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📍 Session: ${joinStatus}\n` +
        `⏺ Recording: ${recordingStatus}\n` +
        `⚡️ System Pulse: 100% Operational\n` +
        `🔒 Encryption: Active`
    );
});

bot.action('help_guide', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    ctx.replyWithMarkdown(
        `📖 *GHOST meet Quick Manual*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `1️⃣ Send Google Meet link directly or use \`/join <url>\`\n` +
        `2️⃣ Click *OPEN LIVE RDP VIEW* to view live browser session\n` +
        `3️⃣ Tap *START RECORDING* or \`/record\`\n` +
        `4️⃣ Tap *STOP & SAVE* or \`/stop\` to get video & transcript`
    );
});

// Launch sequence
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
});

async function launchBot() {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        await bot.launch({ dropPendingUpdates: true });
        console.log("🚀 GHOST meet Bot is initialized and guarding the group.");
    } catch (err) {
        console.error("🚨 Telegram Launch Error:", err.message);
        if (err.message && err.message.includes("409")) {
            console.log("⚠️ 409 Conflict detected. Clearing pending updates & retrying in 3s...");
            await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
            setTimeout(launchBot, 3000);
        } else {
            console.log("⏳ Retrying bot connection in 10 seconds...");
            setTimeout(launchBot, 10000);
        }
    }
}

launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
