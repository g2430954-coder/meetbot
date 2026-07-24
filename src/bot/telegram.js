const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const express = require('express');
const github = require('../utils/github');
const logger = require('../utils/logger');
const ui = require('../utils/ui');

// Load environment variables
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;

// Global session state
const sessionState = {
    isJoined: false,
    isRecording: false,
    currentUrl: null,
    currentChatId: null,
    playerMessageId: null,
    monitorInterval: null
};

// Deduplication Cache
const processedUpdates = new Map();

/**
 * Helper to extract meeting URL from text
 */
function extractMeetingUrl(text) {
    if (!text) return null;
    text = text.trim();
    if (text.startsWith('/join')) {
        const parts = text.split(/\s+/);
        if (parts.length >= 2 && /^https?:\/\//i.test(parts[1])) return parts[1].trim();
    }
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match ? match[0].trim() : null;
}

/**
 * MIDDLEWARE: AUTH & DEDUPLICATION
 */
bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    if (ctx.message && ctx.message.message_id) {
        const msgId = ctx.message.message_id;
        if (processedUpdates.has(msgId)) return;
        processedUpdates.set(msgId, Date.now());
        if (processedUpdates.size > 200) {
            const now = Date.now();
            for (const [id, time] of processedUpdates.entries()) {
                if (now - time > 60000) processedUpdates.delete(id);
            }
        }
    }

    const chatId = ctx.chat.id.toString();
    if (ALLOWED_GROUP_ID && ALLOWED_GROUP_ID !== '*' && chatId !== ALLOWED_GROUP_ID) {
        if (ctx.message && ctx.message.text) {
            return ctx.replyWithMarkdown(`🚨 *GHOST meet | ACCESS DENIED*\nThis terminal is locked to Group ID: \`${ALLOWED_GROUP_ID}\`.`);
        }
        return;
    }

    if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        const rawUrl = extractMeetingUrl(ctx.message.text);
        if (rawUrl) {
            ctx.message.text = `/join ${rawUrl}`;
            return next();
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
        "Status: ✅ *OPERATIONAL*\n\n" +
        "📋 *Commands:*\n" +
        "🔹 `/join <url>` - Start visual engine\n" +
        "🔹 `/record` - Start HD Capture\n" +
        "🔹 `/stop` - Stop & Upload\n" +
        "🔹 `/status` - Engine Diagnostics";

    ctx.replyWithMarkdown(welcomeUI, Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Check Diagnostics', 'engine_status')],
        [Markup.button.callback('📖 Help', 'help_guide')]
    ]));
});

/**
 * /join <url> - Deploy visual engine
 */
bot.command('join', async (ctx) => {
    const meetingUrl = extractMeetingUrl(ctx.message.text);
    if (!meetingUrl) return ctx.replyWithMarkdown("❌ *Error:* Invalid or missing URL.");

    if (sessionState.isJoined) {
        return ctx.replyWithMarkdown("⚠️ *Active Session Exists*. Use `/stop` first.");
    }

    sessionState.currentUrl = meetingUrl;
    sessionState.currentChatId = ctx.chat.id;
    sessionState.isJoined = true;

    const player = ui.generatePlayerUI({ status: 'INITIALIZING', progress: 1, meetingUrl });
    const msg = await ctx.replyWithMarkdown(player.text, player.markup);
    sessionState.playerMessageId = msg.message_id;

    try {
        await github.triggerRunner(meetingUrl, sessionState.playerMessageId, ctx.chat.id.toString());
        const dispatchedUI = ui.generatePlayerUI({ status: 'DEPLOYING', progress: 3, meetingUrl });
        await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, dispatchedUI.text, {
            parse_mode: 'Markdown', ...dispatchedUI.markup
        }).catch(() => {});
        startWorkflowMonitor(ctx);
    } catch (error) {
        sessionState.isJoined = false;
        const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl });
        await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, errorUI.text + `\n\n🚨 *Failure:* ${error.message}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
});

/**
 * Handle Record execution
 */
async function handleRecord(ctx) {
    if (!sessionState.isJoined) return ctx.replyWithMarkdown("❌ *Error:* Not joined yet.");
    if (sessionState.isRecording) return;

    sessionState.isRecording = true;

    // Update the same message to show STARTING
    const startingUI = ui.generatePlayerUI({
        status: 'RECORDING',
        meetingUrl: sessionState.currentUrl,
        progress: 100,
        logs: ["Recording signal sent...", "Engaging engine..."]
    });

    if (sessionState.playerMessageId) {
        await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, startingUI.text, {
            parse_mode: 'Markdown', ...startingUI.markup
        }).catch((e) => logger.error("Edit error in handleRecord:", e.message));
    }

    try {
        await github.triggerRecordRunner(ctx.chat.id.toString(), sessionState.playerMessageId);
    } catch (error) {
        sessionState.isRecording = false;
        logger.error("GitHub Record Trigger Failure:", error);
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
    if (!sessionState.isJoined) return;

    sessionState.isRecording = false;

    // Update the same message to show FINALIZING
    const stoppingUI = ui.generatePlayerUI({
        status: 'FINALIZING',
        meetingUrl: sessionState.currentUrl,
        progress: 10,
        logs: ["Stop signal sent.", "Finalizing assets..."]
    });

    if (sessionState.playerMessageId) {
        await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, stoppingUI.text, {
            parse_mode: 'Markdown', ...stoppingUI.markup
        }).catch((e) => logger.error("Edit error in handleStop:", e.message));
    }

    try {
        await github.triggerStopRunner(ctx.chat.id.toString(), sessionState.playerMessageId);
    } catch (error) {
        logger.error("GitHub Stop Trigger Failure:", error);
    } finally {
        // Reset state after a long buffer
        setTimeout(() => {
            sessionState.isJoined = false;
            sessionState.isRecording = false;
            sessionState.currentUrl = null;
            sessionState.playerMessageId = null;
            if (sessionState.monitorInterval) clearInterval(sessionState.monitorInterval);
        }, 60000);
    }
}

bot.command('stop', handleStop);
bot.action('cmd_stop', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    return handleStop(ctx);
});

bot.command('status', (ctx) => {
    const diagnosticUI =
        "📟 *SYSTEM DIAGNOSTICS*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        `📍 Session: ${sessionState.isJoined ? "🟢 CONNECTED" : "🔴 DISCONNECTED"}\n` +
        `⏺ Recording: ${sessionState.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE"}\n` +
        "⚡️ Kernel: *Operational*";
    ctx.replyWithMarkdown(diagnosticUI);
});

function startWorkflowMonitor(ctx) {
    if (sessionState.monitorInterval) clearInterval(sessionState.monitorInterval);
    sessionState.monitorInterval = setInterval(async () => {
        if (!sessionState.isJoined) {
            clearInterval(sessionState.monitorInterval);
            return;
        }
        const isRunning = await github.isWorkflowRunning();
        if (!isRunning && sessionState.isJoined) {
            sessionState.isJoined = false;
            sessionState.isRecording = false;
            if (sessionState.playerMessageId) {
                const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl: sessionState.currentUrl });
                await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined,
                    errorUI.text + "\n\n🚨 *System Error:* Cloud runner stopped unexpectedly.",
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }
            clearInterval(sessionState.monitorInterval);
        }
    }, 20000);
}

// Inline Actions
bot.action('engine_status', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    const recordingStatus = sessionState.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE";
    ctx.replyWithMarkdown(`📟 *ENGINE DIAGNOSTICS*\nStatus: ${recordingStatus}`);
});

bot.action('help_guide', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    ctx.replyWithMarkdown(`📖 *Quick Help*\n1️⃣ Send link\n2️⃣ Start Recording\n3️⃣ Stop & Save`);
});

const app = express();
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 10000);

async function launchBot() {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
        bot.launch({ dropPendingUpdates: true }).then(() => {
            console.log("🚀 GHOST meet Bot initialized.");
        }).catch(() => setTimeout(launchBot, 5000));
    } catch (err) { setTimeout(launchBot, 5000); }
}
launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
