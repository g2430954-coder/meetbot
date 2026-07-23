require('dotenv').config();

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  ALLOWED_GROUP_ID: process.env.ALLOWED_GROUP_ID,
  NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN,
  PORT: process.env.PORT || 8080,
  CHROME_PATH: process.env.CHROME_PATH || '/usr/bin/chromium'
};
