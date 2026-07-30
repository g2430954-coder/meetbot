import sys
import os
import wave
import contextlib
import time
import requests

# Try to import Whisper for High-Quality Local STT
try:
    import whisper
    import torch
    HAS_WHISPER = True
    WHISPER_MODEL = whisper.load_model("base")
except Exception as e:
    HAS_WHISPER = False

# Try to import SpeechRecognition for Fallback
try:
    import speech_recognition as sr
    HAS_SR = True
except Exception:
    HAS_SR = False

# Try to import transliteration library for Hinglish mode
try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate
    HAS_TRANSLIT = True
except Exception:
    HAS_TRANSLIT = False

CHUNK_DURATION = 20  # 20s speech frames

def get_audio_duration(audio_file):
    try:
        with contextlib.closing(wave.open(audio_file, 'r')) as f:
            frames = f.getnframes()
            rate = f.getframerate()
            return frames / float(rate)
    except Exception:
        return 0

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
    except Exception:
        return text

def transcribe_with_cloud_api(audio_file):
    """Transcribe using Groq or OpenAI Cloud API if API Key is present"""
    groq_key = os.getenv("GROQ_API_KEY")
    openai_key = os.getenv("OPENAI_API_KEY")

    if groq_key:
        try:
            url = "https://api.groq.com/openai/v1/audio/transcriptions"
            headers = {"Authorization": f"Bearer {groq_key}"}
            with open(audio_file, "rb") as f:
                files = {"file": (os.path.basename(audio_file), f, "audio/wav")}
                data = {"model": "whisper-large-v3"}
                res = requests.post(url, headers=headers, files=files, data=data, timeout=30)
                if res.status_code == 200:
                    text = res.json().get("text", "")
                    return convert_to_hinglish(text)
        except Exception as e:
            print(f"Groq API Error: {e}")

    if openai_key:
        try:
            url = "https://api.openai.com/v1/audio/transcriptions"
            headers = {"Authorization": f"Bearer {openai_key}"}
            with open(audio_file, "rb") as f:
                files = {"file": (os.path.basename(audio_file), f, "audio/wav")}
                data = {"model": "whisper-1"}
                res = requests.post(url, headers=headers, files=files, data=data, timeout=30)
                if res.status_code == 200:
                    text = res.json().get("text", "")
                    return convert_to_hinglish(text)
        except Exception as e:
            print(f"OpenAI API Error: {e}")

    return None

def transcribe_with_whisper(audio_file):
    """Transcription using OpenAI Whisper (Local AI Engine)"""
    if not HAS_WHISPER:
        return None
    try:
        # Automatic language detection (Hindi + English + Hinglish dynamic recognition)
        result = WHISPER_MODEL.transcribe(audio_file, task="transcribe")
        text = result.get("text", "").strip()
        return convert_to_hinglish(text)
    except Exception as e:
        print(f"Whisper Local Error: {e}")
        return None

def transcribe_with_google(audio_file):
    """Fallback transcription using Google Speech Recognition"""
    if not HAS_SR:
        return None
    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 30
    recognizer.dynamic_energy_threshold = False
    try:
        with sr.AudioFile(audio_file) as source:
            audio_chunk = recognizer.record(source)
            for lang in ['hi-IN', 'en-IN', 'en-US']:
                try:
                    raw_text = recognizer.recognize_google(audio_chunk, language=lang)
                    if raw_text and len(raw_text.strip()) > 1:
                        return convert_to_hinglish(raw_text)
                except Exception:
                    continue
    except Exception as e:
        print(f"Google SR Fallback Error: {e}")
    return None

def run_transcription(audio_file, output_file, is_master=False):
    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file {audio_file} not found.")
        return

    duration = get_audio_duration(audio_file)
    mode_str = "DEEPSCAN (HQ)" if is_master else "SEGMENT"
    print(f"✨ GHOST meet STT [{mode_str}]: Processing {duration:.2f}s audio...")

    extracted_text = None

    # 1. Try Cloud AI API (Groq / OpenAI) if key is provided
    extracted_text = transcribe_with_cloud_api(audio_file)

    # 2. Try Local OpenAI Whisper AI
    if not extracted_text:
        extracted_text = transcribe_with_whisper(audio_file)

    # 3. Fallback to Google SR
    if not extracted_text:
        extracted_text = transcribe_with_google(audio_file)

    if not extracted_text or not extracted_text.strip():
        extracted_text = "No clear speech detected in segment."

    extracted_text = extracted_text.strip()

    # Save to output file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("━━━━━━━━━━━━━━━━━━━━━━\n")
        f.write(f"✨ GHOST meet | AI TRANSCRIPTION ({mode_str})\n")
        f.write("━━━━━━━━━━━━━━━━━━━━━━\n\n")
        f.write(extracted_text + "\n")

    # Print extracted text to stdout so Node.js transcriber receives it
    print(extracted_text)
    print(f"SUCCESS: Transcript saved to {output_file}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
    master_mode = len(sys.argv) > 3 and sys.argv[3] == "--master"
    run_transcription(sys.argv[1], sys.argv[2], is_master=master_mode)
