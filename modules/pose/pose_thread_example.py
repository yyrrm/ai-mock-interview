import threading
import queue
import time
import traceback

import modules.shared_flags as flags

from modules.camera.camera_manager import shared_frame_queue
from modules.pose.pose_module import PoseAnalyzer

# main.py가 import 하는 이름
result_queue = queue.Queue(maxsize=5)


def _make_pose_score_feedback(motion: float, pose_detected: bool):
    """
    - pose_detected=False (가림/사람없음): 점수 None 처리 + 피드백
    - pose_detected=True: motion 기반 간단 점수(너가 쓰던 식)
    """
    if not pose_detected:
        return None, "자세 인식이 되지 않습니다. 카메라가 가려졌거나 화면 밖입니다."

    score = max(0.0, 100.0 - (motion / 2.0) * 100.0)

    if score >= 80:
        fb = "자세가 안정적입니다."
    elif score >= 60:
        fb = "약간의 움직임이 감지됩니다."
    else:
        fb = "움직임이 많아 불안정해 보입니다."
    return float(score), fb


def pose_worker():
    print("Pose Thread Started", flush=True)

    analyzer = PoseAnalyzer()

    scores = []
    last_feedback = ""
    valid_frames = 0
    no_pose_frames = 0

    while flags.RUNNING:
        try:
            if shared_frame_queue.empty():
                time.sleep(0.005)
                continue

            frame = shared_frame_queue.get()
            processed_frame, motion, coords = analyzer.process_frame(frame)

            pose_detected = (coords is not None)

            if not pose_detected:
                no_pose_frames += 1
            else:
                valid_frames += 1

            score, feedback = _make_pose_score_feedback(float(motion), pose_detected)
            last_feedback = feedback

            if score is not None:
                scores.append(score)

            # main.py가 쓰는 형태 유지 (frame, motion, coords)
            # 인식 실패면 motion을 -1로 보내서 "N/A" 처리 가능하게
            motion_to_send = float(motion) if pose_detected else -1.0
            payload = (processed_frame, motion_to_send, coords)

            if result_queue.full():
                try:
                    result_queue.get_nowait()
                except:
                    pass
            result_queue.put(payload)

        except Exception as e:
            print("Pose Thread Error:", e, flush=True)
            traceback.print_exc()
            time.sleep(0.2)

    # 종료 시 최종 출력 (인식된 프레임 기준)
    if len(scores) == 0:
        final_avg = 0.0
        final_fb = "자세 인식 데이터가 없어 점수를 계산할 수 없습니다. (카메라 가림/미검출)"
    else:
        final_avg = sum(scores) / len(scores)
        total = valid_frames + no_pose_frames
        miss_ratio = (no_pose_frames / total) if total else 0.0
        if miss_ratio >= 0.3:
            final_fb = f"{last_feedback} (인식 실패 비율 {miss_ratio*100:.0f}%)"
        else:
            final_fb = last_feedback or "자세 피드백 없음"

    print("================================================")
    print("- 자세 분야 평가 결과 -")
    #print("POSE 최종 결과", flush=True)
    print(f"자세 평균 점수 : {final_avg:.1f} 점", flush=True)
    print("자세 피드백:", flush=True)
    print(f"- {final_fb}", flush=True)

    print("Pose Thread Stopped", flush=True)


def start_pose_thread():
    t = threading.Thread(target=pose_worker, daemon=False)
    t.start()
    print("pose_thread_example 실행됨!", flush=True)
    return t