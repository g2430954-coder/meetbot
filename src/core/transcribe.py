import sys
import os
import speech_recognition as sr
import wave
import contextlib
import time

# Try to import Whisper for High-Quality Local STT
try:
    import whisper
    import torch
    HAS_WHISPER = True
    # Load model once at module level (using 'base' for speed vs accuracy balance)
    WHISPER_MODEL = whisper.load_model("base")
except ImportError:
    HAS_WHISPER = False

# Try to import transliteration library for Hinglish mode
try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate
    HAS_TRANSLIT = True
except ImportError:
    HAS_TRANSLIT = False

CHUNK_DURATION = 20  # 20s speech frames
OVERLAP = 10         # 10s overlap (50%) for DeepScan coverage

def get_audio_duration(audio_file):
    with contextlib.closing(wave.open(audio_file, 'r')) as f:
        frames = f.getnframes()
        rate = f.getframerate()
        duration = frames / float(rate)
        return duration

def convert_to_hinglish(text):
    """Convert Devanagari text to Hinglish (Romanized)"""
    if not text or not text.strip():
        return ""
    if not HAS_TRANSLIT:
        return text
    try:
        has_devanagari = any('\u0900' <= char <= '\u097f' for char in text)
        if has_devanagari:
            return transliterate(text, sanscript.DEVANAGARI, sanscript.ITRANS).lower()
        return text
    except Exception as e:
        print(f"Transliteration Error: {e}")
        return text

def transcribe_with_whisper(audio_file):
    """Transcription using OpenAI Whisper (Local)"""
    if not HAS_WHISPER:
        return None
    try:
        result = WHISPER_MODEL.transcribe(audio_file, language="hi", task="transcribe")
        return convert_to_hinglish(result["text"])
    except Exception as e:
        print(f"Whisper Error: {e}")
        return None

def transcribe_with_google(audio_chunk, recognizer):
    """Fallback transcription using Google Speech Recognition"""
    languages = ['hi-IN', 'en-IN', 'en-US', 'hi']
    for lang in languages:
        try:
            raw_text = recognizer.recognize_google(audio_chunk, language=lang)
            if raw_text and len(raw_text.strip()) > 1:
                return convert_to_hinglish(raw_text)
        except (sr.UnknownValueError, sr.RequestError):
            continue
    return None

def deduplicate_text(current_lines, new_text):
    """Simple check to avoid double-printing overlapping speech"""
    if not current_lines or not new_text:
        return new_text

    last_line = current_lines[-1].split(']', 1)[-1].strip().lower()
    new_clean = new_text.strip().lower()

    # If the new text is already largely contained in the last line, skip or trim
    if new_clean in last_line or last_line in new_clean:
        if len(new_clean) > len(last_line):
            return new_text # Keep the longer version
        return "" # Skip duplicate

    return new_text

def run_transcription(audio_file, output_file, is_master=False):
    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file {audio_file} not found.")
        return

    try:
        duration = get_audio_duration(audio_file)
        mode_str = "DEEPSCAN (HQ)" if is_master else "SEGMENT"
        engine_str = "WHISPER" if HAS_WHISPER else "GOOGLE_FALLBACK"
        print(f"GHOST meet STT [{mode_str}] via {engine_str}: Processing {duration:.2f}s audio...")
    except Exception as e:
        print(f"Warning: Could not determine duration: {e}")
        duration = None

    # Initialize output file
    if not os.path.exists(output_file):
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write("━━━━━━━━━━━━━━━━━━━━━━\n")
            f.write(f"✨ GHOST meet | AI TRANSCRIPTION ({mode_str})\n")
            f.write("━━━━━━━━━━━━━━━━━━━━━━\n\n")

    # If in master mode and Whisper is available, process the whole file at once
    if is_master and HAS_WHISPER:
        full_text = transcribe_with_whisper(audio_file)
        if full_text:
            with open(output_file, 'a', encoding='utf-8') as f:
                f.write(full_text + "\n")
            print(f"SUCCESS: Master transcript (Whisper) saved to {output_file}")
            return

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 25 if is_master else 45
    recognizer.dynamic_energy_threshold = False
    recognizer.pause_threshold = 1.0

    try:
        with sr.AudioFile(audio_file) as source:
            offset = 0
            lines_written = []

            while True:
                if duration and offset >= duration:
                    break

                print(f"STT: Scanning window at {offset}s...")
                try:
                    audio_chunk = recognizer.record(source, duration=CHUNK_DURATION)
                except EOFError:
                    break

                if not audio_chunk or not audio_chunk.frame_data:
                    break
                        
                # Attempt Google fallback (Whisper is better for whole files, Google handles chunks well)
                chunk_text = transcribe_with_google(audio_chunk, recognizer)

                if chunk_text and chunk_text.strip():
                    unique_text = deduplicate_text(lines_written, chunk_text.strip())
                    if unique_text:
                        timestamp = f"[{int(offset/60)}:{int(offset%60):02d}]"
                        line = f"{timestamp} {unique_text}"
                        with open(output_file, 'a', encoding='utf-8') as f:
                            f.write(line + "\n")
                        lines_written.append(line)

                # DeepScan Overlap
                offset += (CHUNK_DURATION - OVERLAP)
                if CHUNK_DURATION <= OVERLAP: offset += 1

        if is_master:
            with open(output_file, 'a', encoding='utf-8') as f:
                f.write("\n━━━━━━━━━━━━━━━━━━━━━━\n")
                f.write(f"SYSTEM: DEEPSCAN COMPLETE\n")

        print(f"SUCCESS: Transcript saved to {output_file}")

    except Exception as e:
        print(f"STT CRITICAL ERROR: {str(e)}")
        with open(output_file, 'a', encoding='utf-8') as f:
            f.write(f"\n🚨 STT ERROR: {str(e)}\n")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
    master_mode = len(sys.argv) > 3 and sys.argv[3] == "--master"
    run_transcription(sys.argv[1], sys.argv[2], is_master=master_mode)
