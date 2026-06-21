import threading
import queue
import time
import traceback
import os

from modules.voice.voice_module import record_until_silence, preprocess_audio
from modules.voice.stt_google import google_stt
from modules.evaluation.voice_evaluator import VoiceEvaluator

import modules.shared_flags as flags

voice_result_queue = queue.Queue(maxsize=5)


def _no_speech_result():
    """음성이 인식되지 않았을 때의 기본 점수/피드백."""
    return 50.0, "음성이 잘 인식되지 않았습니다. 또렷하고 크게 말해보세요."


def voice_worker(rate=16000):
    print("Voice Thread Started", flush=True)
    print("기본 마이크(Default Input Device) 사용", flush=True)

    # 평가기는 루프 밖에서 1개만 생성 → 발화 사이의 음량 baseline(EMA)을 누적 유지
    evaluator = VoiceEvaluator()

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
            except Exception as e:
                print("파일 크기 확인 실패:", e, flush=True)

            preprocess_audio(audio_path, rate)
            print("전처리 완료", flush=True)

            print("STT 처리 중...", flush=True)
            stt_text, stt_confidence = google_stt(audio_path)
            text = stt_text or "(음성 없음)"
            print(f"\n[Voice Recognized]\n>> {text}", flush=True)

            t = (text or "").strip()
            metrics = None
            if not t or t == "(음성 없음)":
                # 인식 실패 → 평가 생략, 기본 피드백
                score, feedback = _no_speech_result()
            else:
                # 평가지표 기반 실제 음성 평가
                # (말속도 WPM / 음량 / 침묵 + 기준문장 없으면 STT 신뢰도로 명료도)
                try:
                    res = evaluator.evaluate(audio_path, text, stt_confidence=stt_confidence)
                    score = res.total_score
                    feedback = res.feedback
                    metrics = res.metrics
                    print(f"[Voice Metrics] {metrics}", flush=True)
                except Exception as ev_err:
                    # 평가 실패해도 스레드는 죽지 않게 안전 폴백
                    print("음성 평가 실패 → 기본 점수 사용:", ev_err, flush=True)
                    score, feedback = 80.0, "발화가 정상적으로 인식되었습니다."

            scores.append(float(score))
            last_feedback = feedback

            # main.py가 그대로 받도록 dict 유지 (text/score/feedback) + metrics 추가
            result = {
                "text": text,
                "score": score,
                "feedback": feedback,
                "metrics": metrics,
                "timestamp": time.time()
            }

            if voice_result_queue.full():
                try:
                    voice_result_queue.get_nowait()
                except Exception as e:
                    print("결과 큐 비우기 실패:", e, flush=True)
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