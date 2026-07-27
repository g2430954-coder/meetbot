# 🧩 GHOST-meet | Chrome Extension Support

GHOST-meet is powered by **Official Google Chrome Stable** and supports full Chrome Extensions!

## How to add Chrome Extensions:

### Method 1: Drop `.zip` or `.crx` Files
Simply copy your Chrome extension `.zip` or `.crx` file into this `extensions/` directory (e.g. `extensions/my_extension.zip`).
The engine will **automatically extract and load** the extension when Chrome launches!

### Method 2: Unpacked Extension Folder
Copy the unpacked extension folder directly into `extensions/` (so that `extensions/my_extension/manifest.json` exists).

### Method 3: Environment Variable
You can specify custom extension directory paths using the `CHROME_EXTENSIONS` environment variable:
```env
CHROME_EXTENSIONS=/path/to/extension1,/path/to/extension2
```

---

## Chrome Extensions Compatibility
- ✅ All Chrome Extensions (uBlock Origin, Chrome Web Store extensions, custom MV2 & MV3 extensions) are supported.
- ✅ Chrome user data and extension storage are persisted in `output/chrome_profile`.
- ✅ Access extension popups and settings via the live RDP VNC dashboard!
