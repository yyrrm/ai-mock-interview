# 별도로 face_setup 기능이 불필요하다 판단하여 face_detect에 통합
import cv2
from emotion_detect import emotion_detect
from emotion_stabilizer import emo_stabilizer

def face_detect(video_path, detector=None, frame_interval=30, display=True):
    frame_crop = None
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

            # detect_image에서 다른 기능을 제외하고 감지한 얼굴의 bounding box만 반환하는 기능으로 교체, 처리 속도 향상
            result = detector.detect_faces(rgb_frame)

            if result is not None:
                print(f"[Frame {frame_count}], {len(result)} face(s) detected")

                # detect_faces로 감지한 얼굴의 box 좌표 추출
                for face in result:
                    box = face[0]
                    x1, y1, x2, y2, conf = map(int, box[:5])

                    frame_crop = frame[y1-20:y2+20, x1-20:x2+20]
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    frame_path = "frame.jpg"
                    cv2.imwrite(frame_path, frame_crop)

                emotion_result = emotion_detect("frame.jpg", detector)
                emotion_result_smoothed = emo_stabilizer(emotion_result)
                if emotion_result_smoothed is not None:
                    print("원본 감정 수치:", emotion_result["emotions"])
                    print("이동평균:", emotion_result_smoothed["smoothed"])
                    print("최대 감정:", emotion_result["dominant"])
                else:
                    print("감정 분석 실패")

                if display:
                    cv2.putText(frame_crop, f"[Frame {frame_count}]", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)
                    cv2.imshow("Frame", frame_crop)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break



        frame_count += 1

    cap.release()
    cv2.destroyAllWindows()
