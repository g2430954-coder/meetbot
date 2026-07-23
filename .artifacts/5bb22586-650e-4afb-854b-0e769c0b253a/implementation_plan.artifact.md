# Implementation Plan - Real-Time Live Recording & Streaming Suite

This plan upgrades GHOST-meet from a "stop-and-upload" bot to a truly real-time meeting capture engine. It implements live video segmenting, immediate part uploading, and real-time transcription updates, fulfilling the user's request for "real-time call live and recording parts on Telegram."

## User Review Required

> [!IMPORTANT]
> **Live Segmenting Strategy**: Video will be split into 1-minute segments and uploaded immediately to the Telegram chat while the meeting is still active. This ensures that if the meeting or runner crashes, the recording is mostly preserved and accessible in real-time.

> [!TIP]
> **Real-time Transcription**: We will extract audio from each segment and run the AI transcriber immediately. The "Player UI" in Telegram will update to show the latest captured speech.

## Proposed Changes

### Core Logic

#### [MODIFY] [recorder.js](file:///home/ghost/Desktop/GHOST-meet/src/core/recorder.js)
- Update `startRecording()` to use the FFmpeg `segment` muxer.
- Configure segment duration (60s) and output pattern in `output/chunks/`.
- Ensure `-movflags +faststart` is applied to each segment for instant Telegram playback.
- Extract audio segments in parallel for live transcription.

#### [MODIFY] [github_runner.js](file:///home/ghost/Desktop/GHOST-meet/scripts/github_runner.js)
- Add a `segmentWatcher` that polls the `output/chunks/` directory.
- Implement logic to detect when a segment is finalized (closed by FFmpeg).
- Trigger immediate upload of finalized segments to the Telegram chat.
- Trigger "Live Transcription" for each segment and store partial transcripts.
- Update the Heartbeat UI to display the latest transcription snippet and segment count.

### UI & UX Improvements

#### [MODIFY] [ui.js](file:///home/ghost/Desktop/GHOST-meet/src/utils/ui.js)
- Update `generatePlayerUI` to include:
    - `latestTranscript`: Shows the last recognized sentence.
    - `segmentCount`: Displays how many parts have been uploaded so far.
    - Enhanced "RECORDING" status with more dynamic logs.

#### [MODIFY] [telegram.js](file:///home/ghost/Desktop/GHOST-meet/src/bot/telegram.js)
- Add `/live` command support (optional, for RTMP streaming if requested specifically).
- Improve the `/status` command to show real-time metrics from the cloud runner.

### Transcription Engine

#### [MODIFY] [transcriber.js](file:///home/ghost/Desktop/GHOST-meet/src/core/transcriber.js)
- Add `transcribeSegment(audioPath)` for low-latency processing of 60s clips.

---

## Verification Plan

### Automated Tests
- `npm test` (if available, else manual verification of script logic).
- Verify FFmpeg segmenting command in a local terminal.

### Manual Verification
1.  Run `/join <url>` and verify the RDP link works.
2.  Run `/record` and observe the Telegram message.
3.  **Check for real-time uploads**: Every 60-90 seconds, a video file should appear in the Telegram chat automatically.
4.  **Check for live transcript**: The "Player UI" should show the latest spoken words every minute.
5.  Run `/stop` and verify that the final "Master" assets and full transcript are correctly finalized.
