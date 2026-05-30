import threading
import queue
import time
import traceback
import os

from modules.voice.voice_module import record_until_silence, preprocess_audio
from modules.voice.stt_google import google_stt

import modules.shared_flags as flags

voice_result_queue = queue.Queue(maxsize=5)


def _make_voice_score_feedback(text: str):
    """
    임시 점수/피드백(바로 동작하는 버전)
    - 인식 성공: 80
    - 무음/실패: 50
    """
    t = (text or "").strip()
    if not t or t == "(음성 없음)":
        return 50.0, "음성이 잘 인식되지 않았습니다. 또렷하고 크게 말해보세요."
    return 80.0, "발화가 정상적으로 인식되었습니다. 현재 발성 유지!"


def voice_worker(rate=16000):
    print("Voice Thread Started", flush=True)
    print("기본 마이크(Default Input Device) 사용", flush=True)

    scores = []
    last_feedback = ""

    while flags.RUNNING:
        try:
            print("\n> 말하면 녹음 시작...", flush=True)

            audio_path = record_until_silence(
                output_path="temp.wav",
                rate=rate,
                silence_limit=1.2
            )

            if not flags.RUNNING:
                break

            if audio_path is None:
                print("녹음 실패 — 다음 반복", flush=True)
                continue

            print(f"녹음 완료 → {audio_path}", flush=True)
            try:
                print("파일 크기:", os.path.getsize(audio_path), "bytes", flush=True)
            except:
                pass

            preprocess_audio(audio_path, rate)
            print("전처리 완료", flush=True)

            print("STT 처리 중...", flush=True)
            text = google_stt(audio_path) or "(음성 없음)"
            print(f"\n[Voice Recognized]\n>> {text}", flush=True)

            score, feedback = _make_voice_score_feedback(text)
            scores.append(float(score))
            last_feedback = feedback

            # main.py가 그대로 받도록 dict 유지 + score/feedback만 추가
            result = {
                "text": text,
                "score": score,
                "feedback": feedback,
                "timestamp": time.time()
            }

            if voice_result_queue.full():
                try:
                    voice_result_queue.get_nowait()
                except:
                    pass
            voice_result_queue.put(result)

            # ===============================
            # 녹음 사이 쿨다운 (0.3~0.7초)
            # ===============================
            time.sleep(0.5)

        except Exception as e:
            print("Voice Thread Error:", e, flush=True)
            traceback.print_exc()
            time.sleep(0.5)

    # 종료 시 최종 출력
    final_avg = (sum(scores) / len(scores)) if scores else 0.0
    final_fb = last_feedback or "음성 피드백 없음"

    #print("\n==============================", flush=True)
    #print("       VOICE 최종 결과", flush=True)
    #print("==============================", flush=True)
    print("================================================")
    print("- 음성 분야 평가 결과 -")
    print(f"음성 평균 점수 : {final_avg:.1f} 점", flush=True)
    print("음성 피드백:", flush=True)
    print(f"- {final_fb}", flush=True)
    #print("==============================\n", flush=True)

    print("Voice Thread Stopped", flush=True)


def start_voice_thread():
    t = threading.Thread(target=voice_worker, daemon=False)
    t.start()
    print("voice_thread_example 실행됨!", flush=True)
    return t