import sys
import os
import speech_recognition as sr
import wave
import contextlib

# Try to import transliteration library for Hinglish mode
try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate
    HAS_TRANSLIT = True
except ImportError:
    HAS_TRANSLIT = False

CHUNK_DURATION = 12  # 12s speech frames for high-density speech recognition

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
        # Check if text contains Devanagari characters
        has_devanagari = any('\u0900' <= char <= '\u097f' for char in text)
        if has_devanagari:
            return transliterate(text, sanscript.DEVANAGARI, sanscript.ITRANS).lower()
        return text
    except Exception as e:
        print(f"Transliteration Error: {e}")
        return text

def run_transcription(audio_file, output_file):
    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 50  # Ultra-sensitive low threshold for online class audio
    recognizer.dynamic_energy_threshold = False  # Fixed threshold for pre-recorded WAV files
    recognizer.pause_threshold = 0.8  # Prevent speech clipping

    if not os.path.exists(audio_file):
        print(f"ERROR: Audio file {audio_file} not found.")
        return

    try:
        duration = get_audio_duration(audio_file)
        print(f"GHOST meet STT: Processing {duration:.2f}s of audio...")
    except Exception as e:
        print(f"Warning: Could not determine duration: {e}")
        duration = None

    # Initialize output file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("━━━━━━━━━━━━━━━━━━━━━━\n")
        f.write("✨ GHOST meet | AI TRANSCRIPTION (PURE ENGLISH / ROMAN SCRIPT)\n")
        f.write("━━━━━━━━━━━━━━━━━━━━━━\n\n")

    try:
        with sr.AudioFile(audio_file) as source:
            chunks_processed = 0
            offset = 0
            all_text_found = False
            
            while True:
                try:
                    if duration and offset >= duration:
                        break

                    print(f"GHOST meet STT: Processing chunk at offset {offset}s...")
                    audio_chunk = recognizer.record(source, duration=CHUNK_DURATION)

                    if not audio_chunk or not audio_chunk.frame_data:
                        break
                        
                    # 4-Tier Speech Cascade: hi-IN -> en-IN -> en-US -> hi
                    chunk_text = None
                    for attempt in range(2):
                        # 1. Hindi (India) -> Hinglish
                        try:
                            raw_text = recognizer.recognize_google(audio_chunk, language='hi-IN')
                            chunk_text = convert_to_hinglish(raw_text)
                            break
                        except sr.UnknownValueError:
                            pass
                        except sr.RequestError:
                            pass

                        # 2. English (India)
                        try:
                            chunk_text = recognizer.recognize_google(audio_chunk, language='en-IN')
                            break
                        except sr.UnknownValueError:
                            pass
                        except sr.RequestError:
                            pass

                        # 3. English (US)
                        try:
                            chunk_text = recognizer.recognize_google(audio_chunk, language='en-US')
                            break
                        except sr.UnknownValueError:
                            pass
                        except sr.RequestError:
                            pass

                        # 4. General Hindi
                        try:
                            raw_text = recognizer.recognize_google(audio_chunk, language='hi')
                            chunk_text = convert_to_hinglish(raw_text)
                            break
                        except (sr.UnknownValueError, sr.RequestError):
                            break

                    if chunk_text and chunk_text.strip():
                        all_text_found = True
                        formatted_chunk = convert_to_hinglish(chunk_text.strip())

                        with open(output_file, 'a', encoding='utf-8') as f:
                            f.write(f"[{int(offset/60)}:{int(offset%60):02d}] {formatted_chunk}\n")
                    else:
                        print(f"GHOST meet STT: Chunk at {offset}s - no speech detected.")
                    
                    offset += CHUNK_DURATION
                    chunks_processed += 1
                except EOFError:
                    break

        # Finalize output file
        with open(output_file, 'a', encoding='utf-8') as f:
            f.write("\n━━━━━━━━━━━━━━━━━━━━━━\n")
            if all_text_found:
                f.write(f"SYSTEM: STT COMPLETE ({chunks_processed} chunks processed)\n")
            else:
                f.write("SYSTEM: STT COMPLETE (No speech detected)\n")
            f.write("Language Output: 100% English & Romanized Script\n")

        print(f"SUCCESS: Transcript saved to {output_file}")

    except Exception as e:
        print(f"STT CRITICAL ERROR: {str(e)}")
        with open(output_file, 'a', encoding='utf-8') as f:
            f.write(f"\n🚨 STT ERROR: {str(e)}\n")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)

    run_transcription(sys.argv[1], sys.argv[2])
