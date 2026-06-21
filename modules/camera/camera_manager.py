# modules/camera/camera_manager.py

import cv2
import threading
import queue

# 모든 모듈이 공유할 공통 프레임 큐
shared_frame_queue = queue.Queue(maxsize=3)

RUN_CAMERA = True

def camera_worker():
    global RUN_CAMERA

    cap = cv2.VideoCapture(0)

    # 먼저 열기 성공 여부를 확인한 뒤에 속성 설정(set)을 한다.
    if not cap.isOpened():
        print("Camera open failed")
        cap.release()
        return

    cap.set(cv2.CAP_PROP_FPS, 15)

    print("Unified Camera Thread Started")

    # 루프 도중 예외가 나거나 정상 종료되어도 카메라가 반드시 해제되도록 try/finally
    try:
        while RUN_CAMERA:
            ret, frame = cap.read()
            if not ret:
                continue

            # 카메라 좌우 반전
            frame = cv2.flip(frame, 1)

            if shared_frame_queue.full():
                try:
                    shared_frame_queue.get_nowait()
                except Exception as e:
                    print("프레임 큐 비우기 실패:", e)

            shared_frame_queue.put(frame)
    finally:
        cap.release()
        print("Unified Camera Thread Ended")



def start_camera_thread():
    t = threading.Thread(target=camera_worker, daemon=True)
    t.start()
    return t


def stop_camera_thread():
    # 종료 신호: 루프가 빠져나가면 finally 에서 cap.release() 가 호출됨
    global RUN_CAMERA
    RUN_CAMERA = False
