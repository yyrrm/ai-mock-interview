import cv2
import mediapipe as mp
import numpy as np
from collections import deque

# MediaPipe Pose 초기화
mp_pose = mp.solutions.pose
pose = mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5)
mp_drawing = mp.solutions.drawing_utils

# 좌표 안정화를 위한 이동평균 버퍼
smooth_window = 5
landmark_buffer = deque(maxlen=smooth_window)

# 움직임 추적용
prev_coords = None
motion_threshold = 20  # 좌표 이동량 기준 (조정 가능)

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("카메라를 찾을 수 없습니다.")
    exit()

print("실시간 자세 분석 시작 (종료: Q 키)")

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)
    img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    result = pose.process(img_rgb)

    if result.pose_landmarks:
        # 좌표 추출
        landmarks = np.array(
            [(lm.x, lm.y, lm.z) for lm in result.pose_landmarks.landmark]
        )
        landmark_buffer.append(landmarks)

        # 흔들림 보정 (이동 평균 적용)
        smoothed = np.mean(landmark_buffer, axis=0)

        # 움직임 변화량 계산
        motion_value = 0
        if prev_coords is not None:
            motion_value = np.mean(np.linalg.norm(smoothed - prev_coords, axis=1))
        prev_coords = smoothed

        # 시각화
        mp_drawing.draw_landmarks(
            frame, result.pose_landmarks, mp_pose.POSE_CONNECTIONS)

        # FPS 표시 및 움직임 변화 출력
        cv2.putText(frame, f"Motion: {motion_value:.4f}", (30, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

    cv2.imshow('Pose Analysis', frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
