const axios = require('axios');
const logger = require('./logger');

/**
 * Triggers the GitHub Actions workflow via Repository Dispatch
 */
async function triggerRunner(meetingUrl, playerMessageId, chatId) {
    const { PAT_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;

    if (!PAT_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        throw new Error("Missing GitHub configuration (PAT_TOKEN, OWNER, or REPO)");
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`;

    try {
        logger.info(`Triggering GitHub Runner for: ${meetingUrl}`);

        await axios.post(url, {
            event_type: 'start_ghost_runner',
            client_payload: {
                meeting_url: meetingUrl,
                player_message_id: playerMessageId,
                chat_id: chatId
            }
        }, {
            headers: {
                'Authorization': `token ${PAT_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        return true;
    } catch (error) {
        logger.error("GitHub Dispatch Error:", error.response ? error.response.data : error.message);
        throw new Error(`GitHub Dispatch Failed: ${error.message}`);
    }
}

/**
 * Sends stop signal to active GitHub Runner via Repository Dispatch
 */
async function triggerStopRunner(chatId, playerMessageId) {
    const { PAT_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;

    if (!PAT_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        throw new Error("Missing GitHub configuration (PAT_TOKEN, OWNER, or REPO)");
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`;

    try {
        logger.info(`Sending Stop Signal to GitHub Runner...`);

        await axios.post(url, {
            event_type: 'stop_ghost_runner',
            client_payload: {
                player_message_id: playerMessageId,
                chat_id: chatId
            }
        }, {
            headers: {
                'Authorization': `token ${PAT_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        return true;
    } catch (error) {
        logger.error("GitHub Stop Dispatch Error:", error.response ? error.response.data : error.message);
        throw new Error(`GitHub Stop Dispatch Failed: ${error.message}`);
    }
}

module.exports = { triggerRunner, triggerStopRunner };

