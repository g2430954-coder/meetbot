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
    const { status, timer, meetingUrl, vncUrl, partCount, progress, stepLog } = params;
    const icon = STATUS_ICONS[status] || '🛸';

    let uiText = `${icon} *GHOST meet | LIVE PLAYER*\n`;
    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    uiText += `📍 Status: *${status}*\n`;

    if (meetingUrl && !meetingUrl.includes('serveo')) {
        uiText += `🔗 Room Link: [MEETING ROOM](${meetingUrl})\n`;
    }

    const rawRdpUrl = vncUrl || (meetingUrl && meetingUrl.includes('serveo') ? meetingUrl : null);
    let finalVncUrl = null;
    if (rawRdpUrl) {
        finalVncUrl = rawRdpUrl.includes('vnc.html') ? rawRdpUrl : `${rawRdpUrl.replace(/\/$/, '')}/vnc.html?autoconnect=true`;
        uiText += `🖥 Live RDP View: [OPEN RDP DASHBOARD](${finalVncUrl})\n`;
    }

    if (timer) {
        uiText += `⏱ Recording Time: *${timer}*\n`;
    }

    if (progress !== undefined) {
        const label = (status === 'INITIALIZING' || status === 'DEPLOYING') ? '🚀 Deployment Progress' : '📊 Processing Progress';
        uiText += `${label}: ${getProgressBar(progress)}\n`;
    }

    if (partCount) {
        uiText += `🎥 Captured Segments: *${partCount} parts*\n`;
    }

    uiText += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (stepLog) {
        uiText += `${stepLog}`;
    } else if (status === 'INITIALIZING') {
        uiText += `⏳ Step 1/4: Initializing virtual frame buffer & audio bridge...`;
    } else if (status === 'DEPLOYING') {
        uiText += `🚀 Deploying Cloud Runner & setting up live RDP feed...`;
    } else if (status === 'READY') {
        uiText += `✨ System Standby (100% Ready). Tap button below or send /record to start.`;
    } else if (status === 'RECORDING') {
        uiText += `🔴 Capturing 1080p HD Feed + Audio (Stereo)...`;
    } else if (status === 'FINALIZING') {
        uiText += `⚙️ Finalizing capture, splitting MP4 parts & generating English transcript...`;
    } else if (status === 'COMPLETED') {
        uiText += `✅ All video parts and transcript secured in group storage.`;
    }

    // Inline Buttons based on state
    const buttons = [];
    
    if (finalVncUrl) {
        buttons.push([Markup.button.url('🖥 OPEN LIVE RDP VIEW', finalVncUrl)]);
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
