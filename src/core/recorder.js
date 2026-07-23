const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const transcriber = require('./transcriber');

let ffmpegProcess = null;
const outputDir = path.join(__dirname, '../../output');
const rawVideoPath = path.join(outputDir, 'meeting_master.mkv'); // MKV is crash-proof
const masterMp4Path = path.join(outputDir, 'meeting_master.mp4'); // For Telegram
const audioExtractPath = path.join(outputDir, 'meeting_audio.wav');
const chunksDir = path.join(outputDir, 'chunks');

/**
 * Initiates HD FFMPEG capture directly from the virtual frame buffer :99
 */
async function startRecording() {
    await fs.ensureDir(outputDir);
    await fs.emptyDir(outputDir); // Clear previous session data
    await fs.ensureDir(chunksDir);

    logger.info("Initializing HD Stream Capture on :99...");

    /**
     * FFMPEG CONFIGURATION:
     * -f x11grab: Screen capture
     * -f pulse: Audio capture
     * -c:v libx264: H.264 video
     * -preset ultrafast: Low CPU usage
     */
    ffmpegProcess = spawn('ffmpeg', [
        '-f', 'x11grab',
        '-video_size', '1920x1080',
        '-framerate', '30',
        '-i', ':99.0',
        '-f', 'pulse',
        '-i', 'v_sink.monitor',
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y', rawVideoPath, // Record to MKV first
        '-map', '1:a',
        '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', audioExtractPath
    ]);

    ffmpegProcess.on('error', (err) => logger.error(`FFMPEG Startup Error: ${err.message}`));
}

/**
 * Stops capture and triggers the post-processing pipeline
 */
async function stopRecording() {
    if (ffmpegProcess) {
        logger.info("Stopping FFMPEG process...");
        if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed && ffmpegProcess.stdin.writable) {
            try {
                ffmpegProcess.stdin.write('q');
            } catch (err) {
                logger.warn(`Could not write to FFmpeg stdin: ${err.message}`);
                ffmpegProcess.kill('SIGKILL');
            }
        } else {
            ffmpegProcess.kill('SIGKILL');
        }

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn("FFmpeg exit timeout, killing process...");
                ffmpegProcess.kill('SIGKILL');
                resolve();
            }, 10000);

            ffmpegProcess.on('exit', () => {
                clearTimeout(timeout);
                logger.info("FFmpeg exited gracefully.");
                resolve();
            });
        });
    }

    logger.info("Converting MKV to optimized MP4 for Telegram...");
    try {
        if (fs.existsSync(rawVideoPath) && fs.statSync(rawVideoPath).size > 0) {
            // Convert MKV to MP4 with faststart for better playback
            execSync(`ffmpeg -i "${rawVideoPath}" -c copy -movflags +faststart -y "${masterMp4Path}"`);
        } else {
            logger.warn("Raw MKV file is missing or empty.");
        }
    } catch (err) {
        logger.error(`Conversion Error: ${err.message}`);
    }

    logger.info("Master recording finalized. Initiating segmenting and transcription...");

    // 1. Video Chunking (use the MP4 file)
    const videoChunks = await processChunks(masterMp4Path);

    // 2. Transcription (Start AFTER chunking to avoid CPU lag during processing)
    const transcriptPath = await transcriber.transcribe(audioExtractPath);

    return {
        videoChunks,
        transcriptPath
    };
}

/**
 * Post-processing script: Splits recording into 40MB chunks
 */
async function processChunks(filePath) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        logger.error("Master recording not found or empty. Chunking aborted.");
        return [];
    }

    const stats = fs.statSync(filePath);
    const MAX_SIZE = 45 * 1024 * 1024; // 45MB (safe margin below 50MB)

    if (stats.size <= MAX_SIZE) {
        logger.info("File size below 45MB. Skipping segmentation.");
        return [filePath];
    }

    try {
        const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`).toString().trim();
        const duration = parseFloat(durationStr);
        const segmentTime = Math.floor((MAX_SIZE / stats.size) * duration * 0.95);

        const outputPattern = path.join(chunksDir, 'GHOST_meet_Part_%03d.mp4');
        // RE-MUX with +faststart for EACH chunk
        execSync(`ffmpeg -i "${filePath}" -f segment -segment_time ${segmentTime} -c copy -reset_timestamps 1 -movflags +faststart "${outputPattern}"`);

        const chunkFiles = fs.readdirSync(chunksDir)
            .filter(f => f.endsWith('.mp4'))
            .map(f => path.join(chunksDir, f));

        return chunkFiles.sort();
    } catch (error) {
        logger.error(`Chunking Error: ${error.message}`);
        return [filePath];
    }
}

module.exports = {
    startRecording,
    stopRecording
};
