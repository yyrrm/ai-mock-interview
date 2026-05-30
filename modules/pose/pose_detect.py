import cv2
import mediapipe as mp

# MediaPipe Pose 초기화
mp_drawing = mp.solutions.drawing_utils
mp_pose = mp.solutions.pose

cap = cv2.VideoCapture(1, cv2.CAP_DSHOW)

with mp_pose.Pose(
    static_image_mode=False,        # 실시간 스트림
    model_complexity=1,             # 기본 복잡도 (0~2)
    enable_segmentation=False,      # 배경 분할 안함
    min_detection_confidence=0.5,   # 최소 탐지 신뢰도
    min_tracking_confidence=0.5     # 최소 추적 신뢰도
) as pose:

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("프레임을 읽을 수 없습니다.")
            break

        # 색상 변환 (BGR → RGB)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = pose.process(rgb)

        # 포즈 랜드마크(뼈대) 그리기
        if results.pose_landmarks:
            mp_drawing.draw_landmarks(
                frame,
                results.pose_landmarks,
                mp_pose.POSE_CONNECTIONS
            )

        cv2.imshow("Pose Detection (Press Q to Quit)", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

cap.release()
cv2.destroyAllWindows()
