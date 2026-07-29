const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const express = require('express');
const github = require('../utils/github');
const logger = require('../utils/logger');
const ui = require('../utils/ui');

// Load environment variables
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_GROUPS = (process.env.ALLOWED_GROUPS || process.env.ALLOWED_GROUP_ID || "").split(',').map(id => id.trim());

// Global session state
let activeSignal = 'NONE';

const sessionState = {
    isJoined: false,
    isRecording: false,
    currentUrl: null,
    currentChatId: null,
    playerMessageId: null,
    vncUrl: null,
    monitorInterval: null,
    lastActionTime: 0,
    schedule: { start: null, end: null }
};

// Deduplication Cache
const processedUpdates = new Map();

/**
 * Throttled Edit Guard to prevent 429 errors
 */
async function throttledEdit(ctx, text, markup) {
    const now = Date.now();
    if (now - sessionState.lastActionTime < 3500) {
        await new Promise(r => setTimeout(r, 3500 - (now - sessionState.lastActionTime)));
    }
    sessionState.lastActionTime = Date.now();

    if (sessionState.playerMessageId) {
        try {
            return await ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, text, {
                parse_mode: 'Markdown', ...markup
            });
        } catch (e) {
            if (e.description && e.description.includes("message is not modified")) return;
            if (e.description && e.description.includes("Too Many Requests")) {
                const wait = (parseInt(e.description.match(/\d+/)?.[0]) || 5) + 1;
                logger.warn(`Telegram 429 Rate Limit. Backing off ${wait}s before edit retry...`);
                await new Promise(r => setTimeout(r, wait * 1000));
                sessionState.lastActionTime = Date.now();
                return ctx.telegram.editMessageText(ctx.chat.id, Number(sessionState.playerMessageId), undefined, text, {
                    parse_mode: 'Markdown', ...markup
                }).catch(() => {});
            }
            logger.error("Throttled Edit Error:", e.message);
        }
    }
}

/**
 * Helper to convert 12h time (AM/PM) to 24h format HH:mm
 */
function convertTo24Hour(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (!match) return timeStr;

    let [_, hours, minutes, period] = match;
    hours = parseInt(hours);
    minutes = parseInt(minutes);

    if (period) {
        period = period.toLowerCase();
        if (period === 'pm' && hours < 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;
    }

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Helper to extract meeting URL, start time, and end time from text
 */
function parseJoinParams(text) {
    if (!text) return { url: null, displayName: null, start: null, end: null };
    text = text.trim();

    let commandText = text;
    if (text.startsWith('/join')) {
        commandText = text.substring(5).trim();
    }

    // Advanced regex to catch HH:mm with optional AM/PM
    const timeRegex = /\b(\d{1,2}:\d{2}(?:\s*[ap]m)?)\b/gi;
    const times = commandText.match(timeRegex) || [];

    // Remove times from command text to extract URL and Name
    let remainingText = commandText;
    times.forEach(t => {
        remainingText = remainingText.replace(t, '');
    });

    const parts = remainingText.split(/\s+/).filter(p => p.trim());
    let url = null;
    let otherParts = [];

    for (const part of parts) {
        if (/^https?:\/\//i.test(part) && !url) {
            url = part.trim();
        } else {
            otherParts.push(part);
        }
    }

    return {
        url,
        displayName: otherParts.join(' ').trim() || null,
        start: times[0] ? convertTo24Hour(times[0].trim()) : null,
        end: times[1] ? convertTo24Hour(times[1].trim()) : null
    };
}

function extractMeetingUrl(text) {
    return parseJoinParams(text).url;
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
    const isAllowed = ALLOWED_GROUPS.includes('*') || ALLOWED_GROUPS.includes(chatId);

    if (!isAllowed) {
        if (ctx.message && ctx.message.text) {
            return ctx.replyWithMarkdown(`🚨 *GHOST meet | ACCESS DENIED*\nChat ID \`${chatId}\` is not in the authorized list.`);
        }
        return;
    }

    if (ctx.message && ctx.message.text && !ctx.message.text.startsWith('/')) {
        const { url } = parseJoinParams(ctx.message.text);
        if (url) {
            ctx.message.text = `/join ${ctx.message.text}`;
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
        "🛸 *GHOST meet | STEALTH TERMINAL v2.5*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Status: ✅ *KERNEL OPERATIONAL*\n\n" +
        "📋 *Primary Command Syntax:*\n" +
        "🔹 `/join <url> [name] [start] [end]`\n\n" +
        "💡 *Scheduling Examples:*\n" +
        "• _Manual_: `/join https://meet.com/abc` (Control via buttons)\n" +
        "• _Auto-Pilot_: `/join https://meet.com/abc 2:00 PM 3:30 PM` (Full automatic cycle)\n" +
        "• _24h Format_: `/join https://meet.com/abc 14:00 15:30` \n\n" +
        "Use /help for detailed operational manual.";

    ctx.replyWithMarkdown(welcomeUI, Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Check Diagnostics', 'engine_status')],
        [Markup.button.callback('📖 Operational Manual', 'help_guide')]
    ]));
});

/**
 * /help - Detailed user manual
 */
bot.help((ctx) => {
    const helpUI =
        "📖 *GHOST meet | OPERATIONAL MANUAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "1️⃣ *Deploying the Bot*\n" +
        "Send the Google Meet link to this group. The bot will automatically trigger a cloud runner.\n\n" +
        "2️⃣ *Scheduling (Optional)*\n" +
        "To record automatically, include start and end times:\n" +
        "`/join <url> 10:00 AM 11:30 AM` \n" +
        "• The bot will join immediately to 'standby'.\n" +
        "• Recording starts exactly at the start time.\n" +
        "• Recording stops and uploads exactly at the end time.\n\n" +
        "3️⃣ *Manual Control*\n" +
        "If no time is set, use the interactive buttons in the Terminal:\n" +
        "• `START CAPTURE`: Begins 1080p recording.\n" +
        "• `TERMINATE & SAVE`: Stops, splits video, and sends transcript.\n\n" +
        "4️⃣ *Multi-Group Usage*\n" +
        "This bot can be authorized for multiple groups. Contact admin to add your Group ID to the kernel.";

    ctx.replyWithMarkdown(helpUI);
});

/**
 * Resets the session state for a fresh start
 */
function resetSession() {
    activeSignal = 'NONE';
    sessionState.isJoined = false;
    sessionState.isRecording = false;
    sessionState.currentUrl = null;
    sessionState.playerMessageId = null;
    sessionState.vncUrl = null;
    sessionState.schedule = { start: null, end: null };
    if (sessionState.monitorInterval) clearInterval(sessionState.monitorInterval);
}

/**
 * /join <url> [displayName] [start] [end] - Deploy visual engine
 */
bot.command('join', async (ctx) => {
    const { url, displayName, start, end } = parseJoinParams(ctx.message.text);
    if (!url) return ctx.replyWithMarkdown("❌ *Error:* Invalid or missing URL.");

    // Auto-reset if in completed/error state
    if (!sessionState.isRecording && sessionState.isJoined === false) {
        resetSession();
    } else if (sessionState.isJoined) {
        return ctx.replyWithMarkdown("⚠️ *Active Session Exists*. Use `/stop` first.");
    }

    sessionState.currentUrl = url;
    sessionState.currentChatId = ctx.chat.id;
    sessionState.isJoined = true;
    sessionState.schedule = { start, end };

    if (start && !end) {
        ctx.replyWithMarkdown("💡 *Tip:* You provided a start time but no end time. The bot will start recording at your scheduled time, but you will need to stop it manually.");
    }

    const player = ui.generatePlayerUI({
        status: start ? 'SCHEDULED' : 'INITIALIZING',
        progress: 1,
        meetingUrl: url,
        schedule: sessionState.schedule
    });
    const msg = await ctx.replyWithMarkdown(player.text, player.markup);
    sessionState.playerMessageId = msg.message_id;

    try {
        await github.triggerRunner(url, sessionState.playerMessageId, ctx.chat.id.toString(), displayName, start, end);
        const dispatchedUI = ui.generatePlayerUI({
            status: start ? 'SCHEDULED' : 'DEPLOYING',
            progress: 3,
            meetingUrl: url,
            schedule: sessionState.schedule
        });
        await throttledEdit(ctx, dispatchedUI.text, dispatchedUI.markup);
        startWorkflowMonitor(ctx);
    } catch (error) {
        sessionState.isJoined = false;
        const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl: url });
        await throttledEdit(ctx, errorUI.text + `\n\n🚨 *Failure:* ${error.message}`, { parse_mode: 'Markdown' });
    }
});

/**
 * Handle Record execution
 */
async function handleRecord(ctx) {
    if (sessionState.isRecording) return;

    sessionState.isRecording = true;
    activeSignal = 'RECORD';

    const startingUI = ui.generatePlayerUI({
        status: 'RECORDING',
        meetingUrl: sessionState.currentUrl,
        progress: 100,
        logs: ["Manual Override: Starting capture...", "Engaging engine..."]
    });

    await throttledEdit(ctx, startingUI.text, startingUI.markup);

    if (sessionState.vncUrl) {
        try {
            const baseUrl = sessionState.vncUrl.split('/vnc.html')[0];
            const axios = require('axios');
            axios.get(`${baseUrl}/record`, { timeout: 5000 }).catch(() => {});
        } catch (e) {}
    }

    try {
        await github.triggerRecordRunner(ctx.chat.id.toString(), sessionState.playerMessageId);
    } catch (error) {
        logger.error("GitHub Record Trigger Notice:", error.message);
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
    sessionState.isRecording = false;
    activeSignal = 'STOP';

    const stoppingUI = ui.generatePlayerUI({
        status: 'FINALIZING',
        meetingUrl: sessionState.currentUrl,
        progress: 10,
        logs: ["Manual Stop: Closing capture...", "Finalizing assets..."]
    });

    await throttledEdit(ctx, stoppingUI.text, stoppingUI.markup);

    if (sessionState.vncUrl) {
        try {
            const baseUrl = sessionState.vncUrl.split('/vnc.html')[0];
            const axios = require('axios');
            axios.get(`${baseUrl}/stop`, { timeout: 5000 }).catch(() => {});
        } catch (e) {}
    }

    try {
        await github.triggerStopRunner(ctx.chat.id.toString(), sessionState.playerMessageId);
    } catch (error) {
        logger.error("GitHub Stop Trigger Notice:", error.message);
    } finally {
        setTimeout(async () => {
            sessionState.isJoined = false;
            sessionState.isRecording = false;
            await github.cancelAndDeleteRunningWorkflows().catch(() => {});
        }, 15000);
    }
}

bot.command('stop', handleStop);
bot.action('cmd_stop', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    return handleStop(ctx);
});

bot.action('cmd_new_session', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    resetSession();
    await github.cancelAndDeleteRunningWorkflows().catch(() => {});
    return ctx.replyWithMarkdown("🔄 *Terminal Reset Complete.*\nActive workflows cleared.");
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
            if (!sessionState.isRecording) {
                 logger.warn("Workflow monitor detected runner is no longer active.");
                 sessionState.isJoined = false;
                 const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl: sessionState.currentUrl });
                 await throttledEdit(ctx, errorUI.text + "\n\n🚨 *Connection Lost:* The cloud runner went offline unexpectedly.", { parse_mode: 'Markdown' });
                 clearInterval(sessionState.monitorInterval);
            }
        }
    }, 30000);
}

// Inline Actions
bot.action('engine_status', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    const recordingStatus = sessionState.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE";
    ctx.replyWithMarkdown(`📟 *ENGINE DIAGNOSTICS*\nStatus: ${recordingStatus}`);
});

bot.action('help_guide', (ctx) => {
    try { ctx.answerCbQuery(); } catch (e) {}
    const helpUI =
        "📖 *GHOST meet | OPERATIONAL MANUAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "1️⃣ *Deploying the Bot*\n" +
        "Send the Google Meet link. The bot will trigger the runner.\n\n" +
        "2️⃣ *Auto-Pilot Mode*\n" +
        "Set start and end times for full automation:\n" +
        "`/join <url> 10:00 AM 11:30 AM` \n\n" +
        "3️⃣ *Manual Mode*\n" +
        "Use Terminal buttons if no time is set:\n" +
        "• `START CAPTURE`: Begins HD recording.\n" +
        "• `TERMINATE & SAVE`: Finalizes and uploads.";

    ctx.replyWithMarkdown(helpUI);
});

const app = express();
app.get('/', (req, res) => res.status(200).send('GHOST meet Engine Active'));
app.get('/ping', (req, res) => res.status(200).json({ status: 'active', message: 'PONG', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime(), session: sessionState.isJoined ? 'CONNECTED' : 'IDLE' }));
app.get('/get_signal', (req, res) => res.json({ status: 'ok', signal: activeSignal }));
app.get('/set_signal', (req, res) => {
    if (req.query.signal) activeSignal = req.query.signal;
    res.json({ status: 'ok', signal: activeSignal });
});
app.get('/register_vnc', (req, res) => {
    const { vncUrl } = req.query;
    if (vncUrl) {
        sessionState.vncUrl = vncUrl;
        logger.info(`✅ Registered active runner VNC URL: ${vncUrl}`);
    }
    res.json({ status: 'ok', vncUrl: sessionState.vncUrl });
});
app.listen(process.env.PORT || 10000, () => {
    logger.info(`Web server listening on port ${process.env.PORT || 10000} for keep-alive pings.`);
});

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
