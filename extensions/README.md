# Chrome Extensions Directory

Place your unpacked Chrome extensions into this directory to automatically load them when GHOST-meet launches the browser.

## How to add an extension:

1. **Unpacked Extension Folder**:
   Extract/unzip your extension into a folder inside `extensions/`, so that `manifest.json` is located inside the extension folder:
   ```
   extensions/
   └── my-extension/
       ├── manifest.json
       ├── content.js
       └── background.js
   ```

2. **Environment Variable (Optional)**:
   You can also specify external extension folder paths in your `.env` file using `CHROME_EXTENSIONS`:
   ```env
   CHROME_EXTENSIONS=/path/to/extension1,/path/to/extension2
   ```

Any extension placed in `extensions/` or specified in `CHROME_EXTENSIONS` will be automatically detected and loaded into Chrome when starting a meeting.
