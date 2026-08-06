const axios = require('axios');
const logger = require('./logger');

/**
 * Automatically cancels and deletes active/queued workflow runs on GitHub
 */
async function cancelAndDeleteRunningWorkflows(chatId = null, slot = null) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';

    if (!PAT_TOKEN) return;

    try {
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs`;
        const res = await axios.get(url, {
            headers: {
                'Authorization': `token ${PAT_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            params: { per_page: 30 }
        });

        if (res.data && Array.isArray(res.data.workflow_runs)) {
            const now = Date.now();
            for (const run of res.data.workflow_runs) {
                const createdAt = new Date(run.created_at).getTime();
                const isRunning = run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting';

                // Safety Delay: Don't cancel workflows that started in the last 30 seconds
                // to avoid race conditions with newly triggered flows.
                const isOld = (now - createdAt > 30000);

                if (isRunning && isOld) {
                    logger.info(`Cancelling workflow run #${run.id} (${run.name})...`);
                    await axios.post(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run.id}/cancel`, {}, {
                        headers: { 'Authorization': `token ${PAT_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
                    }).catch(() => {});
                    await new Promise(r => setTimeout(r, 500));
                }

                // Delete logs of non-active runs
                if ((run.status === 'completed' || run.status === 'cancelled') && isOld) {
                    logger.info(`Cleaning up workflow logs #${run.id}...`);
                    await axios.delete(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${run.id}`, {
                        headers: { 'Authorization': `token ${PAT_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
                    }).catch(() => {});
                }
            }
        }
    } catch (e) {
        logger.error("Error managing workflows:", e.message);
    }
}

/**
 * Checks if a GHOST runner is already active in GitHub Actions
 */
async function isWorkflowRunning() {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';

    if (!PAT_TOKEN) return false;

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs?per_page=15`;

    try {
        const res = await axios.get(url, {
            headers: {
                'Authorization': `token ${PAT_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (res.data && Array.isArray(res.data.workflow_runs)) {
            return res.data.workflow_runs.some(run => 
                run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting' || run.status === 'requested'
            );
        }
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Sets the GHOST_SIGNAL GitHub Action repository variable for instant runner synchronization
 */
async function setGhostSignal(signalValue) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';
    if (!PAT_TOKEN) return;

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/variables/GHOST_SIGNAL`;
    try {
        await axios.patch(url, { value: signalValue }, {
            headers: { 'Authorization': `token ${PAT_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        logger.info(`GHOST_SIGNAL updated to: ${signalValue}`);
    } catch (err) {
        if (err.response && err.response.status === 404) {
            await axios.post(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/variables`, {
                name: 'GHOST_SIGNAL',
                value: signalValue
            }, {
                headers: { 'Authorization': `token ${PAT_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
            }).catch(e => logger.error("Failed to create GHOST_SIGNAL var:", e.message));
        } else {
            logger.error("Failed to set GHOST_SIGNAL:", err.message);
        }
    }
}

/**
 * Triggers the GitHub Actions workflow via Repository Dispatch
 */
async function triggerRunner(meetingUrl, playerMessageId, chatId, displayName = null, scheduledStart = null, scheduledEnd = null, slot = 1, runStartTime = null) {
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';

    if (!PAT_TOKEN) {
        throw new Error("Missing PAT_TOKEN in Render environment variables. Please add PAT_TOKEN to Render.");
    }

    // Auto-cancel and delete any previous or stuck workflows before launching
    logger.info(`Cleaning up previous workflow runs on GitHub for Slot ${slot}...`);
    await cancelAndDeleteRunningWorkflows(chatId, slot);
    await setGhostSignal('READY');

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`;

    try {
        logger.info(`Triggering GitHub Runner for: ${meetingUrl} (Slot: ${slot})`);

        await axios.post(url, {
            event_type: 'start_ghost_runner',
            client_payload: {
                meeting_url: meetingUrl,
                player_message_id: playerMessageId,
                chat_id: chatId,
                display_name: displayName,
                scheduled_start: scheduledStart,
                scheduled_end: scheduledEnd,
                slot: slot,
                run_start_time: runStartTime || Date.now()
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
 * Sends record start signal to active GitHub Runner via Repository Dispatch and Repo Variable
 */
async function triggerRecordRunner(chatId, playerMessageId) {
    await setGhostSignal('RECORD');
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';

    if (!PAT_TOKEN) {
        throw new Error("Missing PAT_TOKEN in Render environment variables.");
    }

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`;

    try {
        await axios.post(url, {
            event_type: 'record_ghost_runner',
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
 * Sends stop signal to active GitHub Runner via Repository Dispatch and Repo Variable
 */
async function triggerStopRunner(chatId, playerMessageId) {
    await setGhostSignal('STOP');
    const PAT_TOKEN = process.env.PAT_TOKEN || process.env.GITHUB_PAT;
    const GITHUB_OWNER = process.env.GITHUB_OWNER || 'g2430954-coder';
    const GITHUB_REPO = process.env.GITHUB_REPO || 'meetbot';

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

module.exports = { triggerRunner, triggerRecordRunner, triggerStopRunner, isWorkflowRunning, cancelAndDeleteRunningWorkflows, setGhostSignal };

