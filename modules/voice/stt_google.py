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
        return None, None

    # 발화가 여러 구간(result)으로 나뉘어 인식될 수 있으므로
    # 텍스트는 이어붙이고, 신뢰도(confidence)는 평균을 낸다.
    # (팀 합의: 기준 문장이 없는 자유 답변은 confidence 평균값으로 명료도 평가)
    transcripts = []
    confidences = []
    for r in response.results:
        alt = r.alternatives[0]
        transcripts.append(alt.transcript)
        confidences.append(float(alt.confidence))

    transcript = " ".join(transcripts).strip()
    avg_confidence = (sum(confidences) / len(confidences)) if confidences else 0.0
    print(f"Google STT 결과: {transcript}  (confidence avg={avg_confidence:.3f})")
    return transcript, avg_confidence