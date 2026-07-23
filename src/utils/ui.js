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

    if (meetingUrl) {
        uiText += `🔗 Link: [MEETING ROOM](${meetingUrl})\n`;
    }

    if (timer) {
        uiText += `⏱ Time: *${timer}*\n`;
    }

    if (progress !== undefined) {
        uiText += `📊 Progress: ${getProgressBar(progress)}\n`;
    }

    if (partCount) {
        uiText += `🎥 Captured: *${partCount} parts*\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (status === 'READY') {
        uiText += `✨ System Standby. Send /record to start.`;
    } else if (status === 'RECORDING') {
        uiText += `⏺ Capturing HD Native Feed...`;
    } else if (status === 'FINALIZING') {
        uiText += `⚙️ Processing assets...`;
    }

    // Inline Buttons based on state
    const buttons = [];
    if (status === 'READY') {
        buttons.push([Markup.button.callback('⏺ START RECORDING', 'cmd_record')]);
    } else if (status === 'RECORDING') {
        buttons.push([Markup.button.callback('🛑 STOP & SAVE', 'cmd_stop')]);
    }

    if (status !== 'RECORDING' && status !== 'FINALIZING') {
        buttons.push([Markup.button.callback('📟 DIAGNOSTICS', 'engine_status')]);
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
