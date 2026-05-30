from pose_module import PoseAnalyzer
import cv2

analyzer = PoseAnalyzer()
cap = cv2.VideoCapture(0)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    processed, motion, coords = analyzer.process_frame(frame)

    # 변화량(Motion) 표시
    cv2.putText(
        processed,
        f"Motion: {motion:.2f}",
        (10, 40),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        (0, 255, 0),
        3
    )

    # threshold 넘으면 표시 (선택)
    if motion > analyzer.motion_threshold:
        cv2.putText(
            processed,
            "Movement Detected!",
            (10, 80),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0, 0, 255),
            2
        )

    cv2.imshow("Pose Analysis", processed)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
