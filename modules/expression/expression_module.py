import cv2
import numpy as np
import matplotlib.pyplot as plt

plt.rcParams["font.family"] = "Malgun Gothic" # 한글 폰트 호환성 설정
plt.rcParams["axes.unicode_minus"] = False

F_PADDING = 20

# 시각화용 감정 수치 기록 리스트
list_for_emo_plot = []

# 모듈 본체, cv2 입력/타 기능 함수 호출
def run_module(video_path, detector=None, frame_interval=30, display=False):
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

            result = detector.detect_faces(rgb_frame)
            try:
                if result is not None:
                    print(f"[Frame {frame_count}], {len(result)} face(s) detected")

                    # detect_faces로 감지한 얼굴의 box 좌표 추출
                    for face in result:

                        box = face[0]

                        x1, y1, x2, y2, conf = map(int, box[:5])

                        # 감지한 좌표 기준 F_Padding만큼 여유를 두고 crop
                        frame_crop = frame[y1-F_PADDING:y2+F_PADDING, x1-F_PADDING:x2+F_PADDING]
                        # 실제 감지 범위를 사격형으로 시현
                        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                        frame_path = "frame.jpg"
                        cv2.imwrite(frame_path, frame_crop)

                    # Detector를 포함하는 실제 감정 감지 함수 호출, 감정 수치 값 dict 반환
                    emotion_result = emotion_detect("frame.jpg", detector)
                    # 이동평균 계산 함수 호출, smoothing 적용 dict 반환
                    emotion_result_smoothed = emo_stabilize(emotion_result)
                    # 최상단에 선언한 시각화용 list에 저장
                    list_for_emo_plot.append(emotion_result_smoothed["smoothed"])
                    # 콘솔 출력, 다른 interface로 출력 필요 시 이 부분 수정
                    if emotion_result_smoothed is not None:
                        print("원본 감정 수치:", emotion_result["emotions"])
                        print("이동평균:", emotion_result_smoothed["smoothed"])
                        print("최대 감정:", emotion_result["dominant"])
                    else:
                        print("감정 분석 실패")

                    # display 매개변수에 따라 cv2로 입력 및 처리된 프레임 출력
                    if display:
                        cv2.putText(frame_crop, f"[Frame {frame_count}]", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)
                        cv2.imshow("Frame", frame_crop)
                        if cv2.waitKey(1) & 0xFF == ord('q'):
                            break
            except:
                print("Face detection error")
        frame_count += 1

    cap.release()
    cv2.destroyAllWindows()

    # 루프 종료 후, 시각화 함수 출력
    visualize_emo_data(list_for_emo_plot)

# 실제 Detector 함수
def emotion_detect(frame_path, detector=None):
    emotion_cols = ['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise', 'neutral']

    fex = detector.detect_image(frame_path)

    if fex is not None and not fex.empty:
        float_fex = fex.emotions.astype(float)
        float_fex = float_fex[emotion_cols].round(4)
        dominant = float_fex.idxmax(axis=1).values[0]

        return {
            "emotions": float_fex[emotion_cols].iloc[0].to_dict(),
            "dominant": dominant
        }
    else:
        return None


# 이동평균 계산용 임시 리스트
emotion_buffer = []
# 이동평균 계산, smoothing 적용 함수
def emo_stabilize(data, window_size = 5):
    if data is None:
        return None
    else:
        # 임시 리스트에 현재 프레임 감정 수치 추가
        emotion_buffer.append(data["emotions"])
        if len(emotion_buffer) > window_size:
            emotion_buffer.pop(0)

        # 각 감정 컬럼별 이동평균 계산
        smoothed_emotions = {}
        emotions = data["emotions"].keys()

        for col in emotions:
            values = [item[col] for item in emotion_buffer]
            kernel = np.ones(len(values)) / len(values)

            avg = np.convolve(values, kernel, mode="valid")[-1]
            smoothed_emotions[col] = round(avg, 4)

        return {
            "smoothed": smoothed_emotions
        }

# 시각화 함수
def visualize_emo_data(data=None):
    if data is not None:

        categories = list(data[0].keys())
        emotion_series = {cat: [] for cat in categories}
        for emo_dict in data:
            for cat in categories:
                emotion_series[cat].append(emo_dict[cat])

        plt.figure(figsize=(12, 5))
        for cat in categories:
            plt.plot(emotion_series[cat], label=cat, linewidth=2)

        plt.title("시간별 감정 추이")
        plt.xlabel("시간(프레임)")
        plt.ylabel("감정 수치")
        plt.legend(loc='lower right')
        plt.grid(True, linestyle='--', alpha=0.5)
        plt.tight_layout()
        plt.show()

        return
    else:
        print("No Data")
        return