const { exec } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');
const fs = require('fs-extra');

const pythonScriptPath = path.join(__dirname, 'transcribe.py');

/**
 * Interface for the Python transcription engine
 */
async function transcribe(audioPath) {
    if (!fs.existsSync(audioPath)) {
        logger.warn("Audio file not found for transcription.");
        return null;
    }

    const outputPath = path.join(path.dirname(audioPath), 'GHOST_meet_Transcript.txt');

    logger.info(`Starting transcription for ${audioPath}...`);

    return new Promise((resolve, reject) => {
        // Execute Python transcription script
        exec(`python3 "${pythonScriptPath}" "${audioPath}" "${outputPath}"`, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Transcription Script Error: ${stderr}`);
                return resolve(null); // Resolve with null so bot doesn't crash
            }

            logger.info(`Transcription complete: ${stdout.trim()}`);
            if (fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                resolve(null);
            }
        });
    });
}

module.exports = {
    transcribe
};
