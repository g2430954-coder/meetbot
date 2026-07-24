const { Markup } = require('telegraf');

/**
 * GHOST meet | Advanced UI Engine v2.0
 * Generates a "Cyber Terminal" aesthetic for the capture suite
 */

const STATUS_ICONS = {
    INITIALIZING: '⚡',
    DEPLOYING: '🛰',
    READY: '🟢',
    RECORDING: '🔴',
    FINALIZING: '⚙️',
    COMPLETED: '🏁',
    ERROR: '⚠️'
};

function generatePlayerUI(params) {
    const {
        status,
        timer,
        meetingUrl,
        vncUrl,
        partCount,
        progress,
        stepLog,
        latestTranscript,
        logs = [] // Array of last 3-5 log entries
    } = params;

    const icon = STATUS_ICONS[status] || '🛸';

    // 1. HEADER SECTION
    let uiText = `\`[ GHOST-MEET v2.0 | KERNEL ACTIVE ]\`\n`;
    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    // 2. STATUS & TELEMETRY BLOCK
    uiText += `📍 STATUS: *${status}* ${icon}\n`;
    if (timer) {
        uiText += `⏱ UPTIME: \`${timer}\`\n`;
    }

    // Fake/Simulated Telemetry for "Cool" factor
    const pulse = status === 'RECORDING' ? 'HIGH' : 'NORMAL';
    uiText += `📊 SYSTEM: \`⚡Pulse:${pulse}\` | \`📟CPU:12%\` | \`📡Signal:MAX\`\n`;

    if (partCount) {
        uiText += `🎥 STORAGE: \`${partCount} segments secured\`\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    // 3. PROGRESS & LOGS SECTION
    if (progress !== undefined && status !== 'RECORDING') {
        const label = (status === 'INITIALIZING' || status === 'DEPLOYING') ? 'DEPLOYMENT' : 'PROCESSING';
        uiText += `📡 *${label} FEED:*\n`;
        uiText += `${getAdvancedProgressBar(progress)}\n\n`;
    }

    // Rolling Terminal Logs
    if (logs.length > 0 || stepLog) {
        uiText += `📟 *TERMINAL OUTPUT:*\n`;
        uiText += `\`\`\``;
        const displayLogs = logs.length > 0 ? logs.slice(-3) : [stepLog];
        displayLogs.forEach(log => {
            uiText += `\n> ${log}`;
        });
        uiText += `\`\`\`\n`;
    }

    // 4. LIVE DASHBOARD (TRANSCRIPT)
    if (status === 'RECORDING' || latestTranscript) {
        uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        uiText += `📜 *LIVE TRANSCRIPTION DASHBOARD:*\n`;
        uiText += `\`\`\``;
        uiText += latestTranscript ? `\n"${latestTranscript}"` : `\nWaiting for active speech stream...`;
        uiText += `\`\`\`\n`;
    }

    // 5. FOOTER & LINKS
    if (meetingUrl && !meetingUrl.includes('serveo')) {
        uiText += `🔗 [MEETING ROOM](${meetingUrl}) | `;
    }

    const rawRdpUrl = vncUrl || (meetingUrl && meetingUrl.includes('serveo') ? meetingUrl : null);
    let finalVncUrl = null;
    if (rawRdpUrl) {
        finalVncUrl = rawRdpUrl.includes('vnc.html') ? rawRdpUrl : `${rawRdpUrl.replace(/\/$/, '')}/vnc.html?autoconnect=true`;
        uiText += `🖥 [LIVE RDP DASHBOARD](${finalVncUrl})\n`;
    } else {
        uiText += `\n`;
    }

    // Inline Buttons
    const buttons = [];
    if (finalVncUrl) {
        buttons.push([Markup.button.url('🖥 OPEN RDP VIEW', finalVncUrl)]);
    }

    if (status === 'READY') {
        buttons.push([Markup.button.callback('⏺ START CAPTURE', 'cmd_record')]);
    } else if (status === 'RECORDING') {
        buttons.push([Markup.button.callback('🛑 TERMINATE & SAVE', 'cmd_stop')]);
    }

    if (status !== 'RECORDING' && status !== 'FINALIZING') {
        buttons.push([Markup.button.callback('📟 DIAGNOSTICS', 'engine_status')]);
    }

    return {
        text: uiText,
        markup: Markup.inlineKeyboard(buttons)
    };
}

function getAdvancedProgressBar(percent) {
    const total = 15; // 15 blocks
    const progress = Math.round((percent / 100) * total);
    const remaining = total - progress;
    // Using cyberpunk style blocks
    return `\`▰${"▰".repeat(progress)}${"▱".repeat(remaining)}▱\` \`${percent}%\``;
}

module.exports = {
    generatePlayerUI,
    STATUS_ICONS
};
