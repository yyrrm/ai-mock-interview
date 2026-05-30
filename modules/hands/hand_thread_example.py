import cv2
import threading
import queue
import mediapipe as mp

from modules.shared_flags import RUNNING
from modules.camera.camera_manager import shared_frame_queue   # 🔥 공통 카메라 큐 사용

# 분석 결과 → main.py
hands_result_queue = queue.Queue(maxsize=5)

# MediaPipe Hands 초기화
mp_hands = mp.solutions.hands
mp_draw = mp.solutions.drawing_utils


# ======================================================
# Hands 분석 스레드
# ======================================================
def hands_worker():
    hands = mp_hands.Hands(
        max_num_hands=2,
        model_complexity=1,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    print("Hands Thread Started")

    while RUNNING:

        # 카메라 프레임이 아직 안 왔으면 패스
        if shared_frame_queue.empty():
            continue

        # 공통 카메라 프레임 가져오기
        frame = shared_frame_queue.get()

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = hands.process(rgb)

        if result.multi_hand_landmarks:
            for handLms in result.multi_hand_landmarks:
                mp_draw.draw_landmarks(
                    frame, handLms, mp_hands.HAND_CONNECTIONS
                )

        # 최신 결과만 유지
        if hands_result_queue.full():
            try:
                hands_result_queue.get_nowait()
            except:
                pass

        hands_result_queue.put(frame)

    print("Hands Thread Stopped")


# ======================================================
# 스레드 시작 함수
# ======================================================
def start_hands_thread():
    t_hands = threading.Thread(target=hands_worker, daemon=True)
    t_hands.start()

    print("hands_thread_example 실행됨! (Camera 공유 버전)")
    return t_hands


# ======================================================
# 단독 테스트용 코드 (원하면 사용)
# ======================================================
if __name__ == "__main__":
    from modules.camera.camera_manager import start_camera_thread
    start_camera_thread()  # 단독 테스트 시 카메라 실행 필요

    RUNNING = True
    start_hands_thread()

    while True:
        if not hands_result_queue.empty():
            frame = hands_result_queue.get()
            cv2.imshow("Hands Debug", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    RUNNING = False
    cv2.destroyAllWindows()