import pyaudio
import numpy as np
import time

RATE = 16000
CHUNK = 1024


# import 시점에 마이크를 여는 부작용 방지 → 단독 실행시에만 동작하도록 가드
if __name__ == "__main__":
    pa = pyaudio.PyAudio()

    # 입력 장치 목록 출력
    print("=== Input Devices ===")
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if info.get('maxInputChannels', 0) > 0:
            print(f"[{i}] {info['name']}")

    # 기본 입력 장치로 3초 테스트 녹음 + RMS 표시
    stream = pa.open(format=pyaudio.paInt16,
                     channels=1, rate=RATE,
                     input=True, frames_per_buffer=CHUNK)

    # 예외가 발생해도 스트림/PyAudio 자원이 반드시 해제되도록 try/finally 처리
    try:
        print("\nMic test… (3s)")
        start = time.time()
        while time.time() - start < 3:
            data = np.frombuffer(stream.read(CHUNK, exception_on_overflow=False), dtype=np.int16)
            rms = np.sqrt(np.mean(data.astype(np.float32)**2))
            print(f"RMS: {rms:7.2f}", end="\r")
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()

    print("\nMic OK")
