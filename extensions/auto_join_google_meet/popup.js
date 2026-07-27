document.addEventListener('DOMContentLoaded', () => {
    const keys = ['autoJoin', 'autoMuteMic', 'autoMuteCam', 'autoDismissPopups'];
    chrome.storage.sync.get(keys, (res) => {
        keys.forEach(key => {
            const el = document.getElementById(key);
            if (el && res[key] !== undefined) {
                el.checked = res[key];
            }
            if (el) {
                el.addEventListener('change', () => {
                    chrome.storage.sync.set({ [key]: el.checked });
                });
            }
        });
    });
});
