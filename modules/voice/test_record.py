import pyaudio
import wave

rate = 16000
CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1

p = pyaudio.PyAudio()
stream = p.open(
    format=FORMAT,
    channels=CHANNELS,
    rate=rate,
    input=True,
    frames_per_buffer=CHUNK
)

print("3초간 녹음합니다...")

frames = []
for _ in range(int(rate / CHUNK * 3)):
    data = stream.read(CHUNK)
    frames.append(data)

import pyaudio

p = pyaudio.PyAudio()
for i in range(p.get_device_count()):
    info = p.get_device_info_by_index(i)
    print(i, info["name"], info["maxInputChannels"])

stream.stop_stream()
stream.close()
p.terminate()

wf = wave.open("test.wav", "wb")
wf.setnchannels(CHANNELS)
wf.setsampwidth(p.get_sample_size(FORMAT))
wf.setframerate(rate)
wf.writeframes(b"".join(frames))
wf.close()

print("파일 생성됨: test.wav")
