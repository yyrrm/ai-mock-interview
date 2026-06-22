# voice_module.py — SIMPLE & STABLE VERSION
import pyaudio
import wave
import numpy as np
import time

# ======================================
# 1) 말하면 녹음 시작 → 무음이면 종료
# ======================================
def record_until_silence(output_path="temp.wav", rate=16000, silence_limit=1.2):

    CHUNK = 1024
    FORMAT = pyaudio.paInt16
    CHANNELS = 1

    p = pyaudio.PyAudio()

    print("> 말하면 녹음 시작...")

    # device_index 없음 → Windows 기본 마이크 사용
    stream = p.open(
        format=FORMAT,
        channels=CHANNELS,
        rate=rate,
        input=True,
        frames_per_buffer=CHUNK
    )

    frames = []
    triggered = False
    silence_start = None

    while True:
        data = stream.read(CHUNK)
        frames.append(data)

        audio = np.frombuffer(data, dtype=np.int16)
        vol = np.abs(audio).mean()

        # 목소리 감지
        if vol > 200:
            triggered = True
            silence_start = None
        else:
            if triggered and silence_start is None:
                silence_start = time.time()

        # 말 멈춤 감지
        if triggered and silence_start and time.time() - silence_start > silence_limit:
            print("> 말 멈춤 감지 → 녹음 종료")
            break

    stream.stop_stream()
    stream.close()
    p.terminate()

    # WAV 저장
    wf = wave.open(output_path, "wb")
    wf.setnchannels(CHANNELS)
    wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
    wf.setframerate(rate)
    wf.writeframes(b"".join(frames))
    wf.close()

    return output_path


# ======================================
# 2) preprocess_audio — 최소 버전
# (STT 입력을 위해 존재만 하게 함)
# ======================================
def preprocess_audio(audio_path, rate=16000):
    """
    아주 심플하게: 아무 작업도 하지 않고 그대로 반환.
    나중에 noise reduction 넣고 싶으면 여기서 넣으면 됨.
    """
    return audio_path
