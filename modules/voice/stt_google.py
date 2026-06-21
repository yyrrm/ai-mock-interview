# stt_google.py
import os
from google.cloud import speech

def google_stt(audio_path):

    # CWD 가 아니라 프로젝트 루트 기준으로 key.json 위치를 고정
    # (이 파일: modules/voice/stt_google.py → 루트는 세 단계 위)
    project_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..")
    )
    key_path = os.path.join(project_root, "key.json")

    # 존재 확인을 먼저 한 뒤, 파일이 있을 때만 환경변수 설정
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"key.json not found at: {key_path}")

    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key_path

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