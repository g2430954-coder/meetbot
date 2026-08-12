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
 * Initiates HD FFMPEG capture with REAL-TIME SEGMENTING & Keyframe Alignment
 */
async function startRecording() {
    await fs.ensureDir(outputDir);
    await fs.ensureDir(chunksDir);

    ensureAudioEnvironment();

    logger.info("Initializing HD Real-Time Segmenting Capture on :99...");

    // Telegram-Compatible HD Segmenting: H.264 Main Profile + Forced GOP Keyframes + FastStart for Instant In-Chat Playback
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
        '-preset', 'veryfast',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-pix_fmt', 'yuv420p',
        '-g', '60', // Keyframe every 2 seconds (30fps * 2s) - CRITICAL for segmenting & streaming
        '-keyint_min', '30',
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        '-crf', '25',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        '-f', 'segment',
        '-segment_time', '180', // 3 mins (guarantees <50MB size for Telegram sendVideo inline playback)
        '-reset_timestamps', '1',
        '-segment_format_options', 'movflags=+faststart',
        '-avoid_negative_ts', 'make_zero',
        '-fflags', '+genpts',
        '-y', path.join(chunksDir, 'GHOST_part_%03d.mp4')
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpegProcess.on('error', (err) => logger.error(`FFMPEG Startup Error: ${err.message}`));
}

/**
 * Extracts a high-volume normalized mono WAV from a video segment
 */
async function extractAudio(videoPath, audioPath) {
    try {
        try {
            // speechnorm: automatically balances low and high volume speech
            execSync(`ffmpeg -i "${videoPath}" -vn -af "speechnorm=e=4:r=0.0001,volume=2.5" -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}" 2>/dev/null`);
        } catch (filterErr) {
            // Fallback for older FFMPEG builds without speechnorm filter
            execSync(`ffmpeg -i "${videoPath}" -vn -af "volume=2.5" -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}" 2>/dev/null`);
        }
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

/**
 * Remuxes/Re-encodes video segment with +faststart, clean PTS timestamps, and proper headers for Telegram playback
 */
async function preparePlayableVideo(videoPath, outputPath) {
    try {
        if (!fs.existsSync(videoPath)) return videoPath;

        logger.info(`Optimizing video for Telegram in-chat playback: ${path.basename(videoPath)}`);
        
        // 1. Universal Telegram H.264 Baseline profile + yuv420p + faststart moov atom
        try {
            execSync(`ffmpeg -y -err_detect ignore_err -fflags +genpts -i "${videoPath}" -c:v libx264 -preset ultrafast -profile:v baseline -level 3.0 -pix_fmt yuv420p -g 60 -crf 23 -c:a aac -b:a 128k -ar 44100 -ac 2 -avoid_negative_ts make_zero -movflags +faststart "${outputPath}" 2>/dev/null`);
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                return outputPath;
            }
        } catch (reencodeErr) {
            logger.warn(`Re-encode repair warning for ${path.basename(videoPath)}: ${reencodeErr.message}`);
        }

        // 2. Fallback: Stream copy with timestamp normalization and faststart
        execSync(`ffmpeg -y -err_detect ignore_err -fflags +genpts -i "${videoPath}" -c copy -avoid_negative_ts make_zero -movflags +faststart "${outputPath}" 2>/dev/null`);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            return outputPath;
        }

        return videoPath;
    } catch (e) {
        logger.error(`Video FastStart Remux Error: ${e.message}`);
        return videoPath;
    }
}

module.exports = {
    startRecording,
    stopRecording,
    extractAudio,
    preparePlayableVideo
};
