/**
 * Auto Join for Google Meet - Content Script
 * Automatically handles Google Meet pre-join controls and clicks Join button instantly.
 */
(function() {
    'use strict';

    console.log("⚡ Auto Join for Google Meet extension initialized!");

    let config = {
        autoMuteMic: true,
        autoMuteCam: true,
        autoJoin: true,
        autoDismissPopups: true
    };

    // Load saved extension settings from storage
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(['autoMuteMic', 'autoMuteCam', 'autoJoin', 'autoDismissPopups'], (res) => {
            if (res) {
                config = { ...config, ...res };
            }
            startAutoJoinEngine();
        });
    } else {
        startAutoJoinEngine();
    }

    function startAutoJoinEngine() {
        const interval = setInterval(() => {
            if (!location.pathname || location.pathname === '/') return;

            // 1. Auto dismiss popups ("Got it", "Dismiss")
            if (config.autoDismissPopups) {
                const buttons = document.querySelectorAll('button');
                buttons.forEach(btn => {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (text === 'got it' || text === 'dismiss' || text === 'allow') {
                        try { btn.click(); } catch(e) {}
                    }
                });
            }

            // 2. Mute Mic / Cam if on pre-join screen
            const joinButtons = findJoinButtons();
            if (joinButtons.length > 0) {
                if (config.autoMuteMic) muteMic();
                if (config.autoMuteCam) muteCam();

                if (config.autoJoin) {
                    joinButtons[0].click();
                    console.log("✅ Auto Join extension clicked Join button!");
                }
            }
        }, 1000);
    }

    function findJoinButtons() {
        const results = [];
        const buttons = document.querySelectorAll('button, [role="button"]');
        buttons.forEach(btn => {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text.includes('ask to join') || text.includes('join now') || text === 'join' || text.includes('rejoin')) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(btn).visibility !== 'hidden') {
                    results.push(btn);
                }
            }
        });
        return results;
    }

    function muteMic() {
        const micButtons = document.querySelectorAll('button[aria-label*="microphone" i], button[aria-label*="mic" i], [data-is-muted]');
        micButtons.forEach(btn => {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const isMuted = btn.getAttribute('data-is-muted') === 'true' || label.includes('turn on microphone') || label.includes('unmute');
            if (!isMuted && (label.includes('turn off microphone') || label.includes('mute'))) {
                try { btn.click(); } catch(e) {}
            }
        });
    }

    function muteCam() {
        const camButtons = document.querySelectorAll('button[aria-label*="camera" i], button[aria-label*="video" i]');
        camButtons.forEach(btn => {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const isOff = label.includes('turn on camera');
            if (!isOff && (label.includes('turn off camera') || label.includes('turn camera off'))) {
                try { btn.click(); } catch(e) {}
            }
        });
    }
})();
