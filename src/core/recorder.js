const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');

let ffmpegProcess = null;
const outputDir = path.join(__dirname, '../../output');
const chunksDir = path.join(outputDir, 'chunks');

/**
 * Initiates HD FFMPEG capture with REAL-TIME SEGMENTING
 * Segments are saved in output/chunks/ as GHOST_part_000.mp4, etc.
 */
async function startRecording() {
    await fs.ensureDir(outputDir);
    await fs.emptyDir(outputDir);
    await fs.ensureDir(chunksDir);

    logger.info("Initializing HD Real-Time Segmenting Capture on :99...");

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
        '-crf', '28',
        '-b:v', '800k',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-f', 'segment',
        '-segment_time', '900',
        '-reset_timestamps', '1',
        '-movflags', '+faststart',
        '-y', path.join(chunksDir, 'GHOST_part_%03d.mp4')
    ]);

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('fail') || msg.includes('Fatal')) {
            logger.warn(`[FFMPEG STREAM LOG] ${msg.trim()}`);
        }
    });

    ffmpegProcess.on('error', (err) => logger.error(`FFMPEG Startup Error: ${err.message}`));
    ffmpegProcess.on('exit', (code, signal) => {
        logger.info(`FFmpeg process exited with code ${code}, signal ${signal}`);
    });
}

/**
 * Extracts a mono WAV from a video segment for transcription
 */
async function extractAudio(videoPath, audioPath) {
    try {
        execSync(`ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}"`);
        return true;
    } catch (e) {
        logger.error(`Audio Extraction Error: ${e.message}`);
        return false;
    }
}

/**
 * Stops capture gracefully
 */
async function stopRecording() {
    if (ffmpegProcess) {
        logger.info("Stopping FFMPEG process...");
        if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed && ffmpegProcess.stdin.writable) {
            try { ffmpegProcess.stdin.write('q'); } catch (e) {}
        }
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (ffmpegProcess) try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
                resolve();
            }, 4000);

            ffmpegProcess.on('exit', () => {
                clearTimeout(timeout);
                logger.info("FFmpeg exited gracefully.");
                resolve();
            });
        });
        ffmpegProcess = null;
    }

    if (!fs.existsSync(chunksDir)) return { videoChunks: [] };

    const videoChunks = fs.readdirSync(chunksDir)
        .filter(f => f.endsWith('.mp4'))
        .map(f => path.join(chunksDir, f))
        .sort();

    return { videoChunks };
}

module.exports = {
    startRecording,
    stopRecording,
    extractAudio
};
