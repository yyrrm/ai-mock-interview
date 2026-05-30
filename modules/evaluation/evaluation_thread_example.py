# modules/evaluation/evaluation_thread_example.py
import time
import queue
import threading

import modules.shared_flags as flags

# 다른 모듈 큐들(이미 존재하는 것들 import)
from modules.pose.pose_thread_example import result_queue as pose_result_queue
from modules.gaze.gaze_thread_example import gaze_result_queue
from modules.voice.voice_thread_example import voice_result_queue

# main.py가 읽을 평가 결과 큐
evaluation_result_queue = queue.Queue()


def drain_queue(q):
    latest = None
    while not q.empty():
        latest = q.get()
    return latest


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def evaluation_loop():
    print("Evaluation thread started", flush=True)

    # 최신값 캐시
    latest_pose = None
    latest_gaze = None
    latest_voice = None

    # 간단 누적 지표(가중치/평균)
    total_score = 0.0
    n = 0

    while flags.RUNNING:
        # ===== 최신 데이터 수신(없으면 이전 값 유지) =====
        pose_data = drain_queue(pose_result_queue)
        gaze_data = drain_queue(gaze_result_queue)
        voice_data = drain_queue(voice_result_queue)

        if pose_data is not None:
            latest_pose = pose_data
        if gaze_data is not None:
            latest_gaze = gaze_data
        if voice_data is not None:
            latest_voice = voice_data

        # ===== 점수 계산 =====
        # 기본값
        pose_score = None
        gaze_score = None
        voice_score = None

        # 1) Pose: motion 낮을수록 좋음 (너 코드에서 frame, motion, _)
        if latest_pose is not None:
            try:
                _, motion, _ = latest_pose
                # motion 0.0 ~ 2.0 정도라고 가정하고 정규화(값 범위에 맞게 조정 가능)
                # motion=0 => 100점, motion=2 => 0점
                pose_score = clamp(100 - (motion / 2.0) * 100, 0, 100)
            except Exception:
                pose_score = None

        # 2) Gaze: Center / Center일수록 좋음
        if latest_gaze is not None:
            try:
                _, g = latest_gaze
                lr = g.get("left_right", "")
                ud = g.get("up_down", "")
                # 둘 다 Center면 100, 하나만 Center면 70, 둘 다 아니면 40
                c = 0
                if lr == "Center":
                    c += 1
                if ud == "Center":
                    c += 1
                gaze_score = 100 if c == 2 else (70 if c == 1 else 40)
            except Exception:
                gaze_score = None

        # 3) Voice: 텍스트 인식되면 점수 조금 가산(임시)
        if latest_voice is not None and isinstance(latest_voice, dict):
            txt = (latest_voice.get("text") or "").strip()
            voice_score = 80 if len(txt) > 0 else 50

        # ===== 최종 점수(가중 평균) =====
        # 들어온 항목만 평균내기
        parts = []
        if pose_score is not None:
            parts.append(("pose", pose_score))
        if gaze_score is not None:
            parts.append(("gaze", gaze_score))
        if voice_score is not None:
            parts.append(("voice", voice_score))

        if parts:
            # 가중치 (원하면 바꿔)
            weights = {"pose": 0.4, "gaze": 0.4, "voice": 0.2}
            wsum = sum(weights[name] for name, _ in parts)
            score = sum(val * weights[name] for name, val in parts) / (wsum if wsum > 0 else 1.0)
            score = float(clamp(score, 0, 100))

            # 간단 코멘트 생성
            comments = []
            if pose_score is not None:
                comments.append("Posture stable" if pose_score >= 70 else "Too much movement")
            if gaze_score is not None:
                comments.append("Gaze OK" if gaze_score >= 70 else "Gaze unstable")
            if voice_score is not None:
                comments.append("Voice detected" if voice_score >= 70 else "Low/No voice")

            comment = " / ".join(comments)

            # 누적 평균(선택)
            total_score += score
            n += 1
            avg_score = total_score / n

            # main.py로 보내는 값(dict 형태 유지)
            evaluation_result_queue.put({
                "score": int(round(score)),
                "comment": comment,
                "avg": int(round(avg_score)),
                "debug": {
                    "pose": None if pose_score is None else int(round(pose_score)),
                    "gaze": None if gaze_score is None else int(round(gaze_score)),
                    "voice": None if voice_score is None else int(round(voice_score)),
                }
            })

        time.sleep(0.1)


def start_evaluation_thread():
    t = threading.Thread(target=evaluation_loop, daemon=True)
    t.start()
    return t
