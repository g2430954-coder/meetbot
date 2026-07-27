// Auto Join for Google Meet - Service Worker
chrome.runtime.onInstalled.addListener(() => {
    console.log("⚡ Auto Join for Google Meet Extension Installed!");
    chrome.storage.sync.set({
        autoMuteMic: true,
        autoMuteCam: true,
        autoJoin: true,
        autoDismissPopups: true
    });
});
