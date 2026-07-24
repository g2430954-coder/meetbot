const axios = require('axios');
const logger = require('./logger');

/**
 * Checks if a GHOST runner is already active in GitHub Actions
 */
async function isWorkflowRunning() {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'JARRY999Iq';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'GHOST-meet';

    if (!PAT_TOKEN) return false;

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?status=in_progress`;

    try {
        const res = await axios.get(url, {
            headers: {
                'Authorization': `token ${PAT_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        return res.data.total_count > 0;
    } catch (e) {
        return false;
    }
}

/**
 * Triggers the GitHub Actions workflow via Repository Dispatch
 */
async function triggerRunner(meetingUrl, playerMessageId, chatId) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'JARRY999Iq';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'GHOST-meet';

    if (!PAT_TOKEN) {
        throw new Error("Missing PAT_TOKEN in Render environment variables. Please add PAT_TOKEN to Render.");
    }

    // Check if one is already running
    const running = await isWorkflowRunning();
    if (running) {
        throw new Error("A GitHub Action runner is already active. Please wait or stop it first.");
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
 * Sends record start signal to active GitHub Runner via Repository Dispatch
 * NOTE: This does NOT trigger a new workflow, only sends an event.
 */
async function triggerRecordRunner(chatId, playerMessageId) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'JARRY999Iq';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'GHOST-meet';

    if (!PAT_TOKEN) {
        throw new Error("Missing PAT_TOKEN in Render environment variables.");
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`;

    try {
        await axios.post(url, {
            event_type: 'record_ghost_runner', // Runner listens for this
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
        logger.error("GitHub Record Dispatch Error:", error.response ? error.response.data : error.message);
        throw new Error(`GitHub Record Dispatch Failed: ${error.message}`);
    }
}

/**
 * Sends stop signal to active GitHub Runner via Repository Dispatch
 */
async function triggerStopRunner(chatId, playerMessageId) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'JARRY999Iq';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'GHOST-meet';

    if (!PAT_TOKEN) {
        throw new Error("Missing PAT_TOKEN in Render environment variables.");
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

module.exports = { triggerRunner, triggerRecordRunner, triggerStopRunner, isWorkflowRunning };

