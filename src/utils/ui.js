const { Markup } = require('telegraf');

/**
 * GHOST meet | Pro UI Engine
 * Generates consistent, high-end "Video Player" style interfaces
 */

const STATUS_ICONS = {
    INITIALIZING: '⏳',
    DEPLOYING: '🚀',
    READY: '✅',
    RECORDING: '🔴',
    FINALIZING: '💾',
    COMPLETED: '✨',
    ERROR: '🚨'
};

function generatePlayerUI(params) {
    const { status, timer, meetingUrl, partCount, progress } = params;
    const icon = STATUS_ICONS[status] || '🛸';

    let uiText = `${icon} *GHOST meet | LIVE PLAYER*\n`;
    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    uiText += `📍 Status: *${status}*\n`;

    const isVncLink = meetingUrl && (meetingUrl.includes('vnc.html') || meetingUrl.includes('serveo'));

    if (meetingUrl) {
        if (isVncLink) {
            uiText += `🖥 Live RDP View: [OPEN RDP DASHBOARD](${meetingUrl})\n`;
        } else {
            uiText += `🔗 Room Link: [MEETING ROOM](${meetingUrl})\n`;
        }
    }

    if (timer) {
        uiText += `⏱ Recording Time: *${timer}*\n`;
    }

    if (progress !== undefined) {
        uiText += `📊 Processing: ${getProgressBar(progress)}\n`;
    }

    if (partCount) {
        uiText += `🎥 Captured Segments: *${partCount} parts*\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (status === 'READY') {
        uiText += `✨ System Standby. Tap button below or send /record to start.`;
    } else if (status === 'RECORDING') {
        uiText += `⏺ Capturing 1080p HD Feed + Audio...`;
    } else if (status === 'FINALIZING') {
        uiText += `⚙️ Splitting segments & generating English transcript...`;
    }

    // Inline Buttons based on state
    const buttons = [];
    
    if (isVncLink) {
        buttons.push([Markup.button.url('🖥 OPEN LIVE RDP VIEW', meetingUrl)]);
    }

    if (status === 'READY') {
        buttons.push([Markup.button.callback('⏺ START RECORDING', 'cmd_record')]);
    } else if (status === 'RECORDING') {
        buttons.push([Markup.button.callback('🛑 STOP & SAVE', 'cmd_stop')]);
    }

    if (status !== 'RECORDING' && status !== 'FINALIZING') {
        buttons.push([Markup.button.callback('📟 ENGINE DIAGNOSTICS', 'engine_status')]);
    }

    return {
        text: uiText,
        markup: Markup.inlineKeyboard(buttons)
    };
}

function getProgressBar(percent) {
    const total = 10;
    const progress = Math.round((percent / 100) * total);
    const remaining = total - progress;
    return `[${"█".repeat(progress)}${"░".repeat(remaining)}] ${percent}%`;
}

module.exports = {
    generatePlayerUI,
    STATUS_ICONS
};
