import cv2
# from emotion_recog import EmotionDetector #예정

def face_setup(video_path, detector=None, frame_interval=30, display=True):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print("Video Open Error")
        return

    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # 지정한 간격으로 프레임 분석
        if frame_count % frame_interval == 0:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frame_path = "frame.jpg"
            cv2.imwrite(frame_path, rgb_frame)

            result = detector.detect_image(frame_path)
            if result is not None and not result.empty:
                print(f"[Frame {frame_count}], {len(result)} face(s) detected")

                # detect_image로 감지한 얼굴의 box 좌표 추출
                for index, fb in result.faceboxes.iterrows():
                    x = int(fb.get('FaceRectX', fb.get('face_x', 0)))
                    y = int(fb.get('FaceRectY', fb.get('face_y', 0)))
                    w = int(fb.get('FaceRectWidth', fb.get('face_width', 0)))
                    h = int(fb.get('FaceRectHeight', fb.get('face_height', 0)))

                    # 좌표 보정 (음수/프레임 외부 방지)
                    x = max(0, x)
                    y = max(0, y)
                    x2 = min(frame.shape[1], x + w)
                    y2 = min(frame.shape[0], y + h)

                    cv2.rectangle(frame, (x, y), (x2, y2), (0, 255, 0), 2)

                if display:
                    cv2.putText(frame, f"[Frame {frame_count}]", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 0), 1)
                    cv2.imshow("Frame", frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break

        frame_count += 1

    cap.release()
    cv2.destroyAllWindows()