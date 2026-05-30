import cv2
import mediapipe as mp

# MediaPipe FaceMesh 초기화
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(
    max_num_faces=1,
    refine_landmarks=True,  # 눈동자(Iris) 추적을 위해 필수
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

# 1. 눈 윤곽선 (양끝, 위아래)
EYE_OUTLINE_LANDMARKS = [
    # --- 왼쪽 눈 (사용자 기준 Left, 화면상 Right) ---
    33,  # 안쪽 눈꼬리
    133,  # 바깥쪽 눈꼬리
    159,  # 위쪽 눈꺼풀
    145,  # 아래쪽 눈꺼풀
    # --- 오른쪽 눈 (사용자 기준 Right, 화면상 Left) ---
    362,  # 안쪽 눈꼬리
    263,  # 바깥쪽 눈꼬리
    386,  # 위쪽 눈꺼풀
    374,  # 아래쪽 눈꺼풀
]

# 2. 눈동자(Iris) 외곽선 (이것들의 '중심'을 계산할 것입니다)
LEFT_IRIS_INDICES = [474, 475, 476, 477]
RIGHT_IRIS_INDICES = [469, 470, 471, 472]


# 웹캠 열기
cap = cv2.VideoCapture(0)

while cap.isOpened():
    success, image = cap.read()
    if not success:
        break

    image.setflags(write=False)
    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    image_rgb = cv2.flip(image_rgb, 1)  # 좌우반전
    results = face_mesh.process(image_rgb)
    image.setflags(write=True)
    image = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

    image_height, image_width, _ = image.shape

    if results.multi_face_landmarks:
        for face_landmarks in results.multi_face_landmarks:

            # 모든 랜드마크 리스트를 가져옵니다.
            landmarks = face_landmarks.landmark


            # 랜드마크 인덱스로부터 (x, y) 픽셀 좌표를 가져오는 헬퍼 함수
            def get_pixel_coords(index):
                lm = landmarks[index]
                return int(lm.x * image_width), int(lm.y * image_height)


            # 1. 눈 윤곽선(양끝, 위아래) 그리기 (빨간색 원)
            for index in EYE_OUTLINE_LANDMARKS:
                try:
                    cx, cy = get_pixel_coords(index)
                    cv2.circle(image, (cx, cy), 3, (0, 0, 255), 1)  # 빨간색, 얇은 원
                except:
                    pass  # 오류 무시


            try:
                # 왼쪽 눈동자 외곽 4개 점의 좌표를 모두 가져옵니다.
                left_iris_points = [get_pixel_coords(i) for i in LEFT_IRIS_INDICES]

                # X좌표들의 평균을 계산합니다.
                sum_x = sum([p[0] for p in left_iris_points])
                # Y좌표들의 평균을 계산합니다.
                sum_y = sum([p[1] for p in left_iris_points])

                # 평균 좌표 (이것이 바로 '중심'입니다)
                center_left_x = sum_x // len(left_iris_points)
                center_left_y = sum_y // len(left_iris_points)

                # 계산된 중심에 원을 그립니다.
                cv2.circle(image, (center_left_x, center_left_y), 3, (0, 255, 0), -1)  # 초록색, 꽉 찬 원
            except:
                pass

            # 3. 오른쪽 눈동자 '중심' 계산 및 그리기
            try:
                right_iris_points = [get_pixel_coords(i) for i in RIGHT_IRIS_INDICES]
                sum_x = sum([p[0] for p in right_iris_points])
                sum_y = sum([p[1] for p in right_iris_points])
                center_right_x = sum_x // len(right_iris_points)
                center_right_y = sum_y // len(right_iris_points)

                cv2.circle(image, (center_right_x, center_right_y), 3, (0, 255, 0), -1)  # 초록색, 꽉 찬 원
            except:
                pass

    # 결과 보여주기
    cv2.imshow('Pupil Center Landmarks', image)

    if cv2.waitKey(5) & 0xFF == ord('q'):  # q 키 누르면 종료
        break

cap.release()
cv2.destroyAllWindows()