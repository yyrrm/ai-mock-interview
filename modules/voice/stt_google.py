# stt_google.py
import os
from google.cloud import speech

def google_stt(audio_path):

    # 무조건 현재 프로젝트 폴더의 key.json 사용
    key_path = os.path.abspath("key.json")
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key_path

    # 파일 존재 확인
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"key.json not found at: {key_path}")

    client = speech.SpeechClient()

    with open(audio_path, "rb") as audio_file:
        content = audio_file.read()

    audio = speech.RecognitionAudio(content=content)
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=16000,
        language_code="ko-KR"
    )

    response = client.recognize(config=config, audio=audio)

    if not response.results:
        print("인식 결과 없음")
        return None

    transcript = response.results[0].alternatives[0].transcript
    print("Google STT 결과:", transcript)
    return transcript