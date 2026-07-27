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
 * Initiates HD FFMPEG capture with REAL-TIME SEGMENTING & Automatic Retry
 */
async function startRecording() {
    // 1. Clean up any existing FFmpeg instance or orphan processes
    await stopRecording().catch(() => {});
    try { execSync('pkill -9 ffmpeg 2>/dev/null || true'); } catch (e) {}

    await fs.ensureDir(outputDir);
    await fs.ensureDir(chunksDir);

    ensureAudioEnvironment();

    logger.info("Initializing HD Real-Time Segmenting Capture on :99...");

    for (let attempt = 1; attempt <= 3; attempt++) {
        const audioInput = (attempt === 3)
            ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']
            : ['-f', 'pulse', '-i', 'v_sink.monitor'];

        logger.info(`Spawning FFmpeg process (Attempt ${attempt}/3)...`);

        ffmpegProcess = spawn('ffmpeg', [
            '-f', 'x11grab',
            '-video_size', '1920x1080',
            '-framerate', '30',
            '-i', ':99.0',
            ...audioInput,
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

        let hasError = false;
        ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('fail') || msg.includes('Fatal')) {
                logger.warn(`[FFMPEG STREAM LOG] ${msg.trim()}`);
            }
        });

        ffmpegProcess.on('error', (err) => {
            logger.error(`FFMPEG Startup Error: ${err.message}`);
            hasError = true;
        });

        ffmpegProcess.on('exit', (code, signal) => {
            logger.info(`FFmpeg process exited with code ${code}, signal ${signal}`);
        });

        // Wait 1000ms to verify FFmpeg stays running
        await new Promise(r => setTimeout(r, 1000));

        if (ffmpegProcess && ffmpegProcess.exitCode === null && !hasError) {
            logger.info("✅ FFmpeg capture process actively running!");
            return true;
        }

        logger.warn(`FFmpeg failed to stay alive on attempt ${attempt}. Retrying...`);
        ffmpegProcess = null;
        ensureAudioEnvironment();
    }

    throw new Error("Failed to initialize FFmpeg recording engine after 3 attempts.");
}

/**
 * Extracts a mono WAV from a video segment for transcription
 */
async function extractAudio(videoPath, audioPath) {
    try {
        execSync(`ffmpeg -i "${videoPath}" -vn -filter:a "volume=3.0" -acodec pcm_s16le -ar 16000 -ac 1 -y "${audioPath}" 2>/dev/null`);
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
            }, 3000);

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

function isRecordingActive() {
    return ffmpegProcess !== null && ffmpegProcess.exitCode === null;
}

module.exports = {
    startRecording,
    stopRecording,
    extractAudio,
    isRecordingActive
};
