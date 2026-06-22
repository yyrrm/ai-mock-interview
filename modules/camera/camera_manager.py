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

    cap.set(cv2.CAP_PROP_FPS, 15)

    if not cap.isOpened():
        print("Camera open failed")
        return

    print("Unified Camera Thread Started")

    while RUN_CAMERA:
        ret, frame = cap.read()
        if not ret:
            continue

        # 카메라 좌우 반전
        frame = cv2.flip(frame, 1)

        if shared_frame_queue.full():
            try:
                shared_frame_queue.get_nowait()
            except:
                pass

        shared_frame_queue.put(frame)

    cap.release()
    print("Unified Camera Thread Ended")



def start_camera_thread():
    t = threading.Thread(target=camera_worker, daemon=True)
    t.start()
    return t
