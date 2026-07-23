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

CHUNK_DURATION = 30  # 30s chunks for maximum speech capture & fine timestamps

def get_audio_duration(audio_file):
    with contextlib.closing(wave.open(audio_file, 'r')) as f:
        frames = f.getnframes()
        rate = f.getframerate()
        duration = frames / float(rate)
        return duration

def convert_to_hinglish(text):
    """Convert Devanagari text to Hinglish (Romanized)"""
    if not HAS_TRANSLIT:
        return text
    try:
        # Transliteration can be picky, ensure it's not empty
        if not text.strip():
            return ""
        return transliterate(text, sanscript.DEVANAGARI, sanscript.ITRANS).lower()
    except Exception as e:
        print(f"Transliteration Error: {e}")
        return text

def run_transcription(audio_file, output_file):
    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 250  # High audio sensitivity to catch quiet speakers
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.5  # Sensitive pause boundary to prevent speech truncating

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
                    # If we have duration, stop when offset exceeds it
                    if duration and offset >= duration:
                        break

                    print(f"GHOST meet STT: Processing chunk at offset {offset}s...")
                    audio_chunk = recognizer.record(source, duration=CHUNK_DURATION)

                    if not audio_chunk or not audio_chunk.frame_data:
                        break
                        
                    # 3-Tier Speech Cascade: en-IN -> en-US -> hi-IN (transliterated)
                    chunk_text = None
                    for attempt in range(2):
                        try:
                            # 1. Primary: English (India)
                            chunk_text = recognizer.recognize_google(audio_chunk, language='en-IN')
                            break
                        except sr.UnknownValueError:
                            try:
                                # 2. Secondary: English (US)
                                chunk_text = recognizer.recognize_google(audio_chunk, language='en-US')
                                break
                            except sr.UnknownValueError:
                                try:
                                    # 3. Tertiary: Hindi with Roman Transliteration
                                    raw_hi_text = recognizer.recognize_google(audio_chunk, language='hi-IN')
                                    chunk_text = convert_to_hinglish(raw_hi_text)
                                    break
                                except sr.UnknownValueError:
                                    break
                        except sr.RequestError as e:
                            print(f"GHOST meet STT: API retry {attempt+1} at {offset}s due to: {e}")
                            import time
                            time.sleep(1)

                    if chunk_text:
                        all_text_found = True
                        formatted_chunk = convert_to_hinglish(chunk_text)

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
