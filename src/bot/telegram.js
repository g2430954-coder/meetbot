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

// Global session state replaced with Map for Multi-Session Support
const sessions = new Map();
const GHOST_API_KEY = process.env.GHOST_API_KEY || "GHOST_DEFAULT_SECURE_KEY_999";

// Deduplication Cache
const processedUpdates = new Map();

/**
 * Helper to get or initialize session state for a specific chat and slot
 */
function getSession(chatId, slot = 1) {
    const key = `${chatId}_${slot}`;
    if (!sessions.has(key)) {
        sessions.set(key, {
            slot: slot,
            isJoined: false,
            isRecording: false,
            currentUrl: null,
            title: null,
            playerMessageId: null,
            vncUrl: null,
            monitorInterval: null,
            lastActionTime: 0,
            schedule: { start: null, end: null },
            activeSignal: 'NONE'
        });
    }
    return sessions.get(key);
}

/**
 * Global Error Handler to prevent crashes
 */
bot.catch((err, ctx) => {
    logger.error(`Telegraf Error [Update: ${ctx.updateType}]:`, err.message);
});

/**
 * Throttled Edit Guard to prevent 429 errors (Per-Session Slot)
 */
async function throttledEdit(ctx, text, markup, slot = 1) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    const now = Date.now();

    if (now - session.lastActionTime < 3500) {
        await new Promise(r => setTimeout(r, 3500 - (now - session.lastActionTime)));
    }
    session.lastActionTime = Date.now();

    if (session.playerMessageId) {
        try {
            return await ctx.telegram.editMessageText(chatId, Number(session.playerMessageId), undefined, text, {
                parse_mode: 'Markdown', ...markup
            });
        } catch (e) {
            if (e.description && e.description.includes("message is not modified")) return;
            if (e.description && e.description.includes("Too Many Requests")) {
                const wait = (parseInt(e.description.match(/\d+/)?.[0]) || 5) + 1;
                logger.warn(`Telegram 429 Rate Limit [Slot ${slot}]. Backing off ${wait}s...`);
                await new Promise(r => setTimeout(r, wait * 1000));
                session.lastActionTime = Date.now();
                try {
                    return await ctx.telegram.editMessageText(chatId, Number(session.playerMessageId), undefined, text, {
                        parse_mode: 'Markdown', ...markup
                    });
                } catch (retryErr) {
                    logger.error(`Retry Edit Error [Slot ${slot}]:`, retryErr.message);
                }
            }
            logger.error(`Throttled Edit Error [Slot ${slot}]:`, e.message);
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
 * Helper to extract meeting URL, Title, and optionally start/end times
 */
function parseJoinParams(text) {
    if (!text) return { url: null, title: null, displayName: null, start: null, end: null };
    text = text.trim();

    let commandText = text;
    if (text.startsWith('/join')) {
        commandText = text.substring(5).trim();
    }

    // Advanced regex to catch HH:mm with optional AM/PM
    const timeRegex = /\b(\d{1,2}:\d{2}(?:\s*[ap]m)?)\b/gi;
    const times = commandText.match(timeRegex) || [];

    // Remove times from command text to extract URL, Title and Name
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

    // The first part after the URL is considered the TITLE (Mandatory)
    // The rest is considered the Display Name (Optional)
    const title = otherParts[0] || null;
    const displayName = otherParts.slice(1).join(' ').trim() || null;

    return {
        url,
        title,
        displayName,
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
            await ctx.replyWithMarkdown(`🚨 *GHOST meet | ACCESS DENIED*\nChat ID \`${chatId}\` is not in the authorized list.`).catch(() => {});
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
bot.start(async (ctx) => {
    const welcomeUI =
        "🛸 *GHOST meet | STEALTH TERMINAL v2.5*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "Status: ✅ *KERNEL OPERATIONAL*\n\n" +
        "📋 *Primary Command Syntax:*\n" +
        "🔹 `/join <url> <title> [name] [start] [end]`\n\n" +
        "💡 *Scheduling Examples:*\n" +
        "• _Manual_: `/join https://meet.com/abc Daily_Sync` \n" +
        "• _Auto-Pilot_: `/join https://meet.com/abc Sync 2:00 PM 3:30 PM` \n" +
        "• _24h Format_: `/join https://meet.com/abc Meeting 14:00 15:30` \n\n" +
        "Use /help for detailed operational manual.";

    await ctx.replyWithMarkdown(welcomeUI, Markup.inlineKeyboard([
        [Markup.button.callback('⚙️ Check Diagnostics', 'engine_status')],
        [Markup.button.callback('📖 Operational Manual', 'help_guide')]
    ])).catch(() => {});
});

/**
 * /help - Detailed user manual
 */
bot.help(async (ctx) => {
    const helpUI =
        "📖 *GHOST meet | OPERATIONAL MANUAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "1️⃣ *Deploying the Bot*\n" +
        "Send the Google Meet link and a title. The bot will trigger a cloud runner.\n" +
        "Syntax: `/join <url> <title>`\n\n" +
        "2️⃣ *Scheduling (Optional)*\n" +
        "To record automatically, include start and end times:\n" +
        "`/join <url> <title> 10:00 AM 11:30 AM` \n\n" +
        "3️⃣ *Flow Monitoring*\n" +
        "Use `/flows` to see how many meetings are active globally.\n\n" +
        "4️⃣ *Manual Control*\n" +
        "If no time is set, use the interactive buttons in the Terminal:\n" +
        "• `START CAPTURE`: Begins 1080p recording.\n" +
        "• `TERMINATE & SAVE`: Stops, splits video, and sends transcript.";

    await ctx.replyWithMarkdown(helpUI).catch(() => {});
});

/**
 * Resets the session state for a fresh start
 */
function resetSession(chatId) {
    const session = getSession(chatId);
    session.activeSignal = 'NONE';
    session.isJoined = false;
    session.isRecording = false;
    session.currentUrl = null;
    session.playerMessageId = null;
    session.vncUrl = null;
    session.schedule = { start: null, end: null };
    if (session.monitorInterval) {
        clearInterval(session.monitorInterval);
        session.monitorInterval = null;
    }
}

/**
 * Handle Join command for specific slots
 */
async function handleJoin(ctx, slot = 1) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    const { url, title, displayName, start, end } = parseJoinParams(ctx.message.text);

    if (!url) return await ctx.replyWithMarkdown("❌ *Error:* Invalid or missing URL.").catch(() => {});
    if (!title) return await ctx.replyWithMarkdown(`❌ *Error:* Meeting Title is MANDATORY.\nSyntax: \`/join${slot === 1 ? '' : slot} <url> <title>\``).catch(() => {});

    if (session.isJoined) {
        return await ctx.replyWithMarkdown(`⚠️ *Active Session in Slot ${slot} Exists*. Use \`/stop${slot === 1 ? '' : slot}\` first.`).catch(() => {});
    }

    resetSession(chatId, slot);
    session.currentUrl = url;
    session.title = title;
    session.isJoined = true;
    session.schedule = { start, end };

    const player = ui.generatePlayerUI({
        status: start ? 'SCHEDULED' : 'INITIALIZING',
        progress: 1,
        meetingUrl: url,
        schedule: session.schedule,
        slot: slot
    });
    const msg = await ctx.replyWithMarkdown(player.text, player.markup);
    session.playerMessageId = msg.message_id;

    try {
        await github.triggerRunner(url, session.playerMessageId, chatId, displayName, start, end, slot);
        const dispatchedUI = ui.generatePlayerUI({
            status: start ? 'SCHEDULED' : 'DEPLOYING',
            progress: 3,
            meetingUrl: url,
            schedule: session.schedule,
            slot: slot
        });
        await throttledEdit(ctx, dispatchedUI.text, dispatchedUI.markup, slot);
        startWorkflowMonitor(ctx, slot);
    } catch (error) {
        session.isJoined = false;
        const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl: url, slot: slot });
        await throttledEdit(ctx, errorUI.text + `\n\n🚨 *Failure:* ${error.message}`, { parse_mode: 'Markdown' }, slot);
    }
}

bot.command(['join', 'join1', 'join2', 'join3', 'join4', 'join5', 'join6', 'join7', 'join8', 'join9'], async (ctx) => {
    const match = ctx.message.text.match(/\/join(\d)?/);
    const slot = match && match[1] ? parseInt(match[1]) : 1;
    return handleJoin(ctx, slot);
});

/**
 * Handle Record execution
 */
async function handleRecord(ctx, slot = 1) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    if (session.isRecording) return;

    session.isRecording = true;
    session.activeSignal = 'RECORD';

    const startingUI = ui.generatePlayerUI({
        status: 'RECORDING',
        meetingUrl: session.currentUrl,
        progress: 100,
        logs: ["Manual Override: Starting capture...", "Engaging engine..."],
        slot: slot
    });

    await throttledEdit(ctx, startingUI.text, startingUI.markup, slot);

    if (session.vncUrl) {
        try {
            const baseUrl = session.vncUrl.split('/vnc.html')[0];
            const axios = require('axios');
            axios.get(`${baseUrl}/record`, { timeout: 5000 }).catch(() => {});
        } catch (e) {}
    }

    try {
        await github.triggerRecordRunner(chatId, session.playerMessageId);
    } catch (error) {
        logger.error(`GitHub Record Trigger Notice [Slot ${slot}]:`, error.message);
    }
}

bot.command(['record', 'record1', 'record2', 'record3', 'record4', 'record5', 'record6', 'record7', 'record8', 'record9'], (ctx) => {
    const match = ctx.message.text.match(/\/record(\d)?/);
    const slot = match && match[1] ? parseInt(match[1]) : 1;
    return handleRecord(ctx, slot);
});

bot.action(/cmd_record_(\d+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const slot = parseInt(ctx.match[1]);
    return handleRecord(ctx, slot);
});

/**
 * Handle Stop & Save execution
 */
async function handleStop(ctx, slot = 1) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    if (!session.isJoined) return;

    session.isRecording = false;
    session.activeSignal = 'STOP';

    const stoppingUI = ui.generatePlayerUI({
        status: 'FINALIZING',
        meetingUrl: session.currentUrl,
        progress: 10,
        logs: ["Manual Stop: Closing capture...", "Finalizing assets..."],
        slot: slot
    });

    await throttledEdit(ctx, stoppingUI.text, stoppingUI.markup, slot);

    if (session.vncUrl) {
        try {
            const baseUrl = session.vncUrl.split('/vnc.html')[0];
            const axios = require('axios');
            axios.get(`${baseUrl}/stop`, { timeout: 5000 }).catch(() => {});
        } catch (e) {}
    }

    try {
        await github.triggerStopRunner(chatId, session.playerMessageId);
    } catch (error) {
        logger.error(`GitHub Stop Trigger Notice [Slot ${slot}]:`, error.message);
    } finally {
        setTimeout(async () => {
            session.isJoined = false;
            session.isRecording = false;
            await github.cancelAndDeleteRunningWorkflows(chatId).catch(() => {});
        }, 15000);
    }
}

bot.command(['stop', 'stop1', 'stop2', 'stop3', 'stop4', 'stop5', 'stop6', 'stop7', 'stop8', 'stop9'], (ctx) => {
    const match = ctx.message.text.match(/\/stop(\d)?/);
    const slot = match && match[1] ? parseInt(match[1]) : 1;
    return handleStop(ctx, slot);
});

bot.action(/cmd_stop_(\d+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const slot = parseInt(ctx.match[1]);
    return handleStop(ctx, slot);
});

bot.action(/cmd_new_session_(\d+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const slot = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id.toString();
    resetSession(chatId, slot);
    await github.cancelAndDeleteRunningWorkflows(chatId).catch(() => {});
    return ctx.replyWithMarkdown(`🔄 *Terminal Slot ${slot} Reset Complete.*\nActive workflows cleared.`);
});

bot.command(['status', 'status1', 'status2', 'status3', 'status4', 'status5', 'status6', 'status7', 'status8', 'status9'], async (ctx) => {
    const match = ctx.message.text.match(/\/status(\d)?/);
    const slot = match && match[1] ? parseInt(match[1]) : 1;
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    const diagnosticUI =
        `📟 *SYSTEM DIAGNOSTICS | SLOT #${slot}*\n` +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        `📍 Status: ${session.isJoined ? "🟢 CONNECTED" : "🔴 DISCONNECTED"}\n` +
        `📝 Title: \`${session.title || 'N/A'}\`\n` +
        `⏺ Recording: ${session.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE"}\n` +
        "⚡️ Kernel: *Operational*";
    await ctx.replyWithMarkdown(diagnosticUI).catch(() => {});
});

bot.command('flows', async (ctx) => {
    let activeCount = 0;
    const activeFlows = [];

    for (const [key, session] of sessions.entries()) {
        if (session.isJoined) {
            activeCount++;
            const chatId = key.split('_')[0];
            activeFlows.push(`🔹 *${session.title || 'Untitled'}* (Chat ID: \`${chatId}\` | Slot: ${session.slot})`);
        }
    }

    let message = `📟 *ACTIVE ENGINE FLOWS: ${activeCount}*\n`;
    message += "━━━━━━━━━━━━━━━━━━━━━━\n";
    if (activeCount > 0) {
        message += activeFlows.join('\n');
    } else {
        message += "⚪️ No active sessions found.";
    }

    await ctx.replyWithMarkdown(message).catch(() => {});
});

function startWorkflowMonitor(ctx, slot = 1) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    if (session.monitorInterval) clearInterval(session.monitorInterval);
    session.monitorInterval = setInterval(async () => {
        if (!session.isJoined) {
            clearInterval(session.monitorInterval);
            return;
        }
        const isRunning = await github.isWorkflowRunning();
        if (!isRunning && session.isJoined) {
            if (!session.isRecording) {
                 logger.warn(`Workflow monitor [Slot ${slot}] detected runner is offline.`);
                 session.isJoined = false;
                 const errorUI = ui.generatePlayerUI({ status: 'ERROR', meetingUrl: session.currentUrl, slot: slot });
                 await throttledEdit(ctx, errorUI.text + "\n\n🚨 *Connection Lost:* The cloud runner went offline unexpectedly.", { parse_mode: 'Markdown' }, slot);
                 clearInterval(session.monitorInterval);
            }
        }
    }, 30000);
}

// Inline Actions
bot.action(/engine_status_(\d+)/, async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const slot = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId, slot);
    const recordingStatus = session.isRecording ? "🔴 ACTIVE" : "⚪️ IDLE";
    await ctx.replyWithMarkdown(`📟 *ENGINE DIAGNOSTICS | SLOT #${slot}*\nStatus: ${recordingStatus}`).catch(() => {});
});

bot.action('help_guide', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    const helpUI =
        "📖 *GHOST meet | OPERATIONAL MANUAL*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "1️⃣ *Deploying the Bot*\n" +
        "Send: `/join <url> <title>`\n\n" +
        "2️⃣ *Auto-Pilot Mode*\n" +
        "Set start and end times for full automation:\n" +
        "`/join <url> <title> 10:00 AM 11:30 AM` \n\n" +
        "3️⃣ *Monitoring*\n" +
        "Use `/flows` to see active engine count.";

    await ctx.replyWithMarkdown(helpUI).catch(() => {});
});

const app = express();

// Security Middleware
const authMiddleware = (req, res, next) => {
    const key = req.query.key || req.headers['x-api-key'];
    if (key !== GHOST_API_KEY) {
        logger.warn(`Unauthorized access attempt from ${req.ip}`);
        return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API Key' });
    }
    next();
};

app.get('/', (req, res) => res.status(200).send('GHOST meet Engine Active'));
app.get('/ping', (req, res) => res.status(200).json({ status: 'active', message: 'PONG', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

app.get('/get_signal', authMiddleware, (req, res) => {
    const { chat_id, slot } = req.query;
    if (!chat_id) return res.status(400).json({ error: 'Missing chat_id' });
    const session = getSession(chat_id, slot || 1);
    res.json({ status: 'ok', signal: session.activeSignal });
});

app.get('/set_signal', authMiddleware, (req, res) => {
    const { chat_id, slot, signal } = req.query;
    if (!chat_id || !signal) return res.status(400).json({ error: 'Missing parameters' });
    const session = getSession(chat_id, slot || 1);
    session.activeSignal = signal;
    res.json({ status: 'ok', signal: session.activeSignal });
});

app.get('/register_vnc', authMiddleware, (req, res) => {
    const { vncUrl, chat_id, slot } = req.query;
    if (vncUrl && chat_id) {
        const session = getSession(chat_id, slot || 1);
        session.vncUrl = vncUrl;
        logger.info(`✅ Registered active runner VNC URL for chat ${chat_id} [Slot ${slot || 1}]: ${vncUrl}`);
    }
    res.json({ status: 'ok' });
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
