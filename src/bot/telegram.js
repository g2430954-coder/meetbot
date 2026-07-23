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

/**
 * Helper to extract meeting URL from text (supports both /join <url> and raw meeting links)
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
        return null;
    }

    // 2. Direct raw meeting link syntax (meet.google.com or meet links)
    const urlMatch = text.match(/https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:meet\.google\.com|google\.com\/meet|[a-zA-Z0-9-]+\/meet)[^\s]*/i);
    if (urlMatch) {
        return urlMatch[0].trim();
    }

    return null;
}

/**
 * STRICT GROUP AUTHORIZATION & AUTO-LINK DETECTION MIDDLEWARE
 */
bot.use(async (ctx, next) => {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id.toString();

    // 1. Authorization Check: Silent ignore for unauthorized groups (No annoying popups!)
    if (ALLOWED_GROUP_ID && chatId !== ALLOWED_GROUP_ID) {
        return; 
    }

    // 2. Raw Link Auto-Detection
    if (ctx.message && ctx.message.text) {
        const text = ctx.message.text.trim();

        // If it's NOT a / command, check if it's a meeting link
        if (!text.startsWith('/')) {
            const rawUrl = extractMeetingUrl(text);
            if (rawUrl) {
                // Automatically convert raw meeting link into /join command!
                ctx.message.text = `/join ${rawUrl}`;
                return next();
            }
            // Silent ignore for normal chat messages & non-meeting links (No annoying popups!)
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
 * /join <url> - Deploy visual engine (FIXED: No more double-click needed)
 */
bot.command('join', async (ctx) => {
    // PREVENT DOUBLE EXECUTION
    if (sessionState.isJoined) {
        return ctx.replyWithMarkdown("⚠️ *Already Joined*\n━━━━━━━━━━━━━━━━━━━━━━\nMeeting is already active. Use `/stop` to end the session first.");
    }

    const meetingUrl = extractMeetingUrl(ctx.message.text);
    if (!meetingUrl || !/^https?:\/\//i.test(meetingUrl)) {
        return ctx.replyWithMarkdown("❌ *Error:* Invalid or missing URL. Usage: `/join https://meet.google.com/...` ");
    }
    sessionState.currentUrl = meetingUrl;
    sessionState.currentChatId = ctx.chat.id;
    sessionState.isJoined = true;

    // Send INITIALIZING UI
    const player = ui.generatePlayerUI({ status: 'INITIALIZING', meetingUrl });
    const msg = await ctx.replyWithMarkdown(player.text, player.markup);
    sessionState.playerMessageId = msg.message_id;

    // Check if we are on Render
    if (process.env.RENDER) {
        try {
            await github.triggerRunner(meetingUrl, sessionState.playerMessageId, ctx.chat.id.toString());

            // Update UI to DISPATCHED
            const dispatchedUI = ui.generatePlayerUI({ status: 'DEPLOYING', meetingUrl });
            await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, dispatchedUI.text, {
                parse_mode: 'Markdown',
                ...dispatchedUI.markup
            });
        } catch (error) {
            logger.error("GitHub Trigger Failure:", error);
            sessionState.isJoined = false;
            const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
            await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, errorUI.text + `\n\n🚨 *Dispatch Failure:* ${error.message}`, { parse_mode: 'Markdown' });
        }
        return;
    }

    // Local/Non-Render logic
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
 * /record - Start HD FFMPEG Stream with REAL-TIME TIMER
 */
bot.command('record', async (ctx) => {
    if (!sessionState.isJoined) {
        return ctx.replyWithMarkdown("❌ *Error:* Not joined yet. Use `/join <url>` first.");
    }

    if (sessionState.isRecording) {
        return ctx.replyWithMarkdown("⚠️ *Already Recording*\n━━━━━━━━━━━━━━━━━━━━━━\nUse `/stop` to end the current recording.");
    }

    sessionState.isRecording = true;
    sessionState.recordingStartTime = Date.now();

    try {
        await recorder.startRecording();
        
        // START REAL-TIME TIMER UPDATES
        let elapsedSeconds = 0;
        sessionState.timerInterval = setInterval(async () => {
            elapsedSeconds++;
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
                logger.warn("Timer update error (expected):", err.message);
            }
        }, 5000); // Update every 5 seconds to avoid rate limits

    } catch (error) {
        logger.error("Recording Start Failure:", error);
        sessionState.isRecording = false;
        if (sessionState.timerInterval) clearInterval(sessionState.timerInterval);
        await ctx.replyWithMarkdown(`🚨 *Recording Error:* ${error.message}`);
    }
});

/**
 * /stop - Stop, Chunk, and Upload with REAL-TIME STATUS
 */
bot.command('stop', async (ctx) => {
    if (!sessionState.isRecording) {
        return ctx.replyWithMarkdown("⚠️ *Not Recording*\n━━━━━━━━━━━━━━━━━━━━━━\nStart recording with `/record` first.");
    }

    // STOP TIMER
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
        await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, stoppingUI.text, {
            parse_mode: 'Markdown', ...stoppingUI.markup
        });
    }

    try {
        // Get recording duration
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
            await ctx.telegram.editMessageText(ctx.chat.id, sessionState.playerMessageId, null, completedUI.text, {
                parse_mode: 'Markdown', ...completedUI.markup
            });
        }

        // Upload Video Segments with progress
        for (let i = 0; i < assets.videoChunks.length; i++) {
            await ctx.replyWithVideo(
                { source: assets.videoChunks[i] },
                { 
                    caption: `🎥 GHOST meet Recording | Part ${i + 1} of ${assets.videoChunks.length}\n⏱ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}` 
                }
            );
        }

        // Upload AI Transcript
        if (assets.transcriptPath) {
            await ctx.replyWithDocument(
                { source: assets.transcriptPath },
                { caption: "📜 AI Meeting Transcript (English Output)\n📝 Full continuous transcription" }
            );
        }

        // RESET SESSION STATE
        sessionState.isJoined = false;
        sessionState.isRecording = false;
        sessionState.currentUrl = null;
        sessionState.lastMessageId = null;
        sessionState.recordingStartTime = null;

        const finalUI =
            "✨ *SESSION COMPLETE*\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n" +
            "✅ All assets uploaded successfully.\n" +
            "📁 Files secured in group storage.\n" +
            "💤 Engine hibernated.\n\n" +
            "Use `/join <url>` to start a new session.";
        await ctx.replyWithMarkdown(finalUI);

    } catch (error) {
        logger.error("Finalization Failure:", error);
        sessionState.isRecording = false;
        await ctx.replyWithMarkdown(`🚨 *Stop Error:* ${error.message}`);
    }
});

/**
 * /status - Real-time diagnostics and session status
 */
bot.command('status', (ctx) => {
    const recordingStatus = sessionState.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE";
    const joinStatus = sessionState.isJoined ? "🟢 CONNECTED" : "🔴 DISCONNECTED";
    
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
        `⏺ Recording: ${recordingStatus}\n` +
        `⏱ Duration: *${duration}*\n` +
        "⚡️ Kernel: *Stable*\n" +
        "🖥 Virtual Display: *Active (:99)*\n" +
        "🎥 FFMPEG Pipeline: *Ready*\n" +
        "🗣 STT Engine: *Bilingual Mode (Hindi/Hinglish)*\n" +
        "💾 Storage: *Optimized*";
    ctx.replyWithMarkdown(diagnosticUI);
});

// Inline Actions
bot.action('engine_status', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("System pulse: 100%. Encryption layers active. Engine performing within parameters.");
});

bot.action('help_guide', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("GHOST meet Manual:\n1. Use /join for the meeting link.\n2. Manual login via Ngrok link.\n3. /record to start.\n4. /stop to get the files.");
});

// Launch sequence
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, '../../public')));

app.get('/api/status', (req, res) => {
    res.json({
        status: 'SYSTEM OPERATIONAL',
        uptime: process.uptime(),
        joined: sessionState.isJoined,
        recording: sessionState.isRecording,
        currentUrl: sessionState.currentUrl
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
});

function launchBot() {
    bot.launch()
        .then(() => {
            console.log("🚀 GHOST meet Bot is initialized and guarding the group.");
        })
        .catch((err) => {
            console.error("🚨 Telegram Launch Error:", err.message);
            console.log("⏳ Retrying bot connection in 10 seconds...");
            setTimeout(launchBot, 10000); // Retry without crashing the Express server
        });
}

launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
