const { Markup } = require('telegraf');

/**
 * GHOST meet | Advanced UI Engine v2.5
 * Cyber Terminal with Scheduling & Countdown Support
 */

const STATUS_ICONS = {
    INITIALIZING: '⚡',
    DEPLOYING: '🛰',
    SCHEDULED: '📅',
    READY: '🟢',
    RECORDING: '🔴',
    FINALIZING: '⚙️',
    COMPLETED: '🏁',
    ERROR: '⚠️'
};

function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[_*`\[\]]/g, '\\$&');
}

function generatePlayerUI(params) {
    const {
        status,
        meetingUrl,
        vncUrl,
        partCount,
        progress,
        latestTranscript,
        participantName,
        logs = [],
        timers = {}, // uptime, capture, countdown, expiry
        schedule,
        slot = 1
    } = params;

    const icon = STATUS_ICONS[status] || '🛸';

    // 1. HEADER SECTION
    let uiText = `\`[ GHOST-MEET v2.5 | SLOT #${slot} ]\`\n`;
    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    // 2. STATUS & TELEMETRY BLOCK
    uiText += `📍 STATUS: *${status}* ${icon}\n`;

    if (schedule && schedule.start) {
        uiText += `🗓 SCHEDULE: \`${schedule.start} - ${schedule.end || 'MANUAL'}\`\n`;
    }

    if (participantName) {
        uiText += `👤 IDENTITY: \`${escapeMarkdown(participantName)}\`\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    uiText += `📟 *SYSTEM TELEMETRY DASHBOARD:*\n`;
    uiText += `\`\`\``;
    uiText += `\n🌐 SESSION : ${timers.uptime || '00:00'}`;
    uiText += `\n🔴 CAPTURE : ${timers.capture || '--:--'}`;

    if (timers.countdown) {
        const label = status === 'RECORDING' ? 'REMAINING' : 'T-MINUS  ';
        uiText += `\n⏳ ${label}: ${timers.countdown}`;
    }

    if (params.wordCount) {
        uiText += `\n📝 DATA    : ${params.wordCount} words`;
    }

    uiText += `\n🚪 EXPIRES : ${timers.expiry || '06:00:00'}`;
    uiText += `\n⚡ PULSE   : ${status === 'RECORDING' ? 'HIGH-FREQ' : 'STABLE'}`;
    uiText += `\`\`\`\n`;

    if (partCount) {
        uiText += `🎥 STORAGE: \`${partCount} segments secured\`\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    // 3. PROGRESS & LOGS SECTION
    if (progress !== undefined && status !== 'RECORDING' && status !== 'SCHEDULED') {
        const label = (status === 'INITIALIZING' || status === 'DEPLOYING') ? 'DEPLOYMENT' : 'PROCESSING';
        uiText += `📡 *${label} FEED:*\n`;
        uiText += `${getAdvancedProgressBar(progress)}\n\n`;
    }

    if (logs.length > 0) {
        uiText += `📟 *TERMINAL OUTPUT:*\n`;
        uiText += `\`\`\``;
        logs.slice(-3).forEach(log => {
            uiText += `\n> ${String(log).replace(/```/g, '')}`;
        });
        uiText += `\`\`\`\n`;
    }

    // 4. LIVE DASHBOARD (TRANSCRIPT)
    if (status === 'RECORDING' || latestTranscript) {
        uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        uiText += `📜 *LIVE TRANSCRIPTION DASHBOARD:*\n`;
        uiText += `\`\`\``;
        uiText += latestTranscript ? `\n"${String(latestTranscript).replace(/```/g, '')}"` : `\nWaiting for active speech stream...`;
        uiText += `\`\`\`\n`;
    }

    // 5. FOOTER & LINKS
    if (meetingUrl && !meetingUrl.includes('serveo')) {
        uiText += `🔗 [MEETING ROOM](${meetingUrl}) | `;
    }

    const rawRdpUrl = vncUrl || (meetingUrl && meetingUrl.includes('serveo') ? meetingUrl : null);
    if (rawRdpUrl) {
        const finalVncUrl = rawRdpUrl.includes('vnc.html') ? rawRdpUrl : `${rawRdpUrl.replace(/\/$/, '')}/vnc.html?autoconnect=true`;
        uiText += `🖥 [LIVE RDP DASHBOARD](${finalVncUrl})\n`;
    } else {
        uiText += `\n`;
    }

    // Inline Buttons
    const buttons = [];
    if (rawRdpUrl) {
        const finalVncUrl = rawRdpUrl.includes('vnc.html') ? rawRdpUrl : `${rawRdpUrl.replace(/\/$/, '')}/vnc.html?autoconnect=true`;
        buttons.push([Markup.button.url('🖥 OPEN RDP VIEW', finalVncUrl)]);
    }

    if (status === 'READY' || status === 'SCHEDULED') {
        buttons.push([
            Markup.button.callback('⏺ START CAPTURE', `cmd_record_${slot}`),
            Markup.button.callback('🛑 END SESSION', `cmd_stop_${slot}`)
        ]);
    } else if (status === 'RECORDING') {
        buttons.push([Markup.button.callback('🛑 TERMINATE & SAVE', `cmd_stop_${slot}`)]);
    } else if (status === 'COMPLETED' || status === 'ERROR') {
        buttons.push([Markup.button.callback('🔄 NEW SESSION', `cmd_new_session_${slot}`)]);
    }

    if (status !== 'RECORDING' && status !== 'FINALIZING' && status !== 'COMPLETED') {
        buttons.push([Markup.button.callback('📟 DIAGNOSTICS', `engine_status_${slot}`)]);
    }

    return {
        text: uiText,
        markup: Markup.inlineKeyboard(buttons)
    };
}

function getAdvancedProgressBar(percent) {
    const total = 15;
    const progress = Math.round((percent / 100) * total);
    const remaining = total - progress;
    return `\`▰${"▰".repeat(progress)}${"▱".repeat(remaining)}▱\` \`${percent}%\``;
}

module.exports = {
    generatePlayerUI,
    STATUS_ICONS
};
