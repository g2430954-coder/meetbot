const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '../../logs');
if (!fs.existsSync(logPath)) {
  fs.mkdirSync(logPath);
}

module.exports = {
  info: (msg, ...args) => {
    console.log(`[INFO] ${msg}`, ...args);
  },
  error: (msg, ...args) => {
    console.error(`[ERROR] ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`[WARN] ${msg}`, ...args);
  }
};
