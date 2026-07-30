const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');

let ffmpegProcess = null;
const outputDir = path.join(__dirname, '../../output');
const chunksDir = path.join(outputDir, 'chunks');

/**
 * Ensures virtual audio sink (PulseAudio) is alive and configured
 */
function ensureAudioEnvironment() {
    try {
        const sinks = execSync('pactl list sinks short 2>/dev/null || true').toString();
        if (!sinks.includes('v_sink')) {
            logger.info("Setting up Virtual PulseAudio Sink...");
            execSync('pulseaudio -D --exit-idle-time=-1 --disallow-exit 2>/dev/null || true');
            execSync('pactl load-module module-virtual-sink sink_name=v_sink 2>/dev/null || true');
            execSync('pactl set-default-sink v_sink 2>/dev/null || true');

            // Force Max Volumes for Clean Recording
            execSync('pactl set-sink-mute v_sink 0 2>/dev/null || true');
            execSync('pactl set-sink-volume v_sink 100% 2>/dev/null || true');
            execSync('pactl set-source-mute v_sink.monitor 0 2>/dev/null || true');
            execSync('pactl set-source-volume v_sink.monitor 100% 2>/dev/null || true');
        }
    } catch (e) {
        logger.warn(`Audio Setup Notice: ${e.message}`);
    }
}

/**
 * Initiates HD FFMPEG capture with REAL-TIME SEGMENTING
 */
async function startRecording() {
    await fs.ensureDir(outputDir);
    await fs.ensureDir(chunksDir);

    ensureAudioEnvironment();

    logger.info("Initializing HD Real-Time Segmenting Capture on :99...");

    // Segmenting Command: 15-minute parts to prevent huge single files, but small enough for Telegram
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
        '-crf', '26',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-f', 'segment',
        '-segment_time', '900', // 15 mins
        '-reset_timestamps', '1',
        '-movflags', '+faststart',
        '-y', path.join(chunksDir, 'GHOST_part_%03d.mp4')
    ]);

    ffmpegProcess.on('error', (err) => logger.error(`FFMPEG Startup Error: ${err.message}`));
}

/**
 * Extracts a high-volume normalized mono WAV from a video segment
 */
async function extractAudio(videoPath, audioPath) {
    try {
        // speechnorm: automatically balances low and high volume speech
        // volume=2.5: baseline boost for AI clarity
        execSync(`ffmpeg -i "${videoPath}" -vn -af "speechnorm=e=4:r=0.0001,volume=2.5" -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}" 2>/dev/null`);
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
        logger.info("Stopping FFMPEG process gracefully...");
        try {
            if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed && ffmpegProcess.stdin.writable) {
                ffmpegProcess.stdin.write('q');
            }
        } catch (e) {}

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                if (ffmpegProcess) {
                    logger.warn("FFMPEG force killing...");
                    try { ffmpegProcess.kill('SIGKILL'); } catch (e) {}
                }
                resolve();
            }, 5000);

            ffmpegProcess.on('exit', () => {
                clearTimeout(timeout);
                logger.info("FFMPEG exited cleanly.");
                resolve();
            });
        });
        ffmpegProcess = null;
    }
}

module.exports = {
    startRecording,
    stopRecording,
    extractAudio
};
