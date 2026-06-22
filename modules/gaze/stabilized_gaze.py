import cv2
import mediapipe as mp
import math

# q키 누르면 캠 꺼짐
# c키를 눌러서 중앙값(정면) 보정

# MediaPipe FaceMesh 초기화
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

# 1. '안정적인' 랜드마크 (기준점)
STABLE_ANCHOR_POINT = 6  # 미간

# 정규화(크기) 계산을 위한 '안쪽 눈꼬리'
LEFT_EYE_INNER_CORNER = 33
RIGHT_EYE_INNER_CORNER = 362

# 3. 눈동자(Iris) 랜드마크
LEFT_IRIS_HORIZONTAL = [477, 475]   # [Inner, Outer]
RIGHT_IRIS_HORIZONTAL = [470, 472]  # [Inner, Outer]

# --- 보정(Calibration) 관련 변수 ---
is_calibrated = False
calibrated_metric_x = 0.0
calibrated_metric_y = 0.0
current_metric_x = 0.0
current_metric_y = 0.0

# --- EMA(지수 이동 평균) 설정 ---
EMA_ALPHA = 0.25  # 0.2~0.3 정도에서 시작해서 튜닝
ema_diff_x = 0.0
ema_diff_y = 0.0
ema_initialized = False  # 첫 프레임인지 여부

# 시선 판단을 위한 임계값
GAZE_THRESHOLD_X = 0.03    # 좌우 민감도
GAZE_THRESHOLD_Y = 0.015   # 상하 민감도

# 웹캠 열기
cap = cv2.VideoCapture(0)

# 텍스트 관련 설정
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE_MAIN = 1   # 메인 시선 방향 텍스트 크기
FONT_THICKNESS_MAIN = 2  # 메인 시선 방향 텍스트 두께
FONT_SCALE_CALIB = 1  # 보정 상태 텍스트 크기
FONT_THICKNESS_CALIB = 2  # 보정 상태 텍스트 두께
TEXT_COLOR = (0, 255, 0)      # 초록색
CALIB_COLOR_NOT = (0, 0, 255) # 빨간색
CALIB_COLOR_DONE = (0, 255, 0)

# 시선 텍스트 초기값
gaze_direction_x = "Center"
gaze_direction_y = "Center"

while cap.isOpened():
    success, image = cap.read()
    if not success:
        break

    image.setflags(write=False)
    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    image_rgb = cv2.flip(image_rgb, 1)  # 좌우반전 (사용자 기준)
    results = face_mesh.process(image_rgb)
    image.setflags(write=True)
    image = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

    image_height, image_width, _ = image.shape

    if results.multi_face_landmarks:
        for face_landmarks in results.multi_face_landmarks:
            landmarks = face_landmarks.landmark

            def get_pixel_coords(index):
                lm = landmarks[index]
                return int(lm.x * image_width), int(lm.y * image_height)

            try:
                # --- 1. Anchor (미간) ---
                anchor_point = get_pixel_coords(STABLE_ANCHOR_POINT)

                # --- 2. 정규화 기준 거리 (양 눈 안쪽 눈꼬리 사이 거리) ---
                L_inner_corner_for_dist = get_pixel_coords(LEFT_EYE_INNER_CORNER)
                R_inner_corner_for_dist = get_pixel_coords(RIGHT_EYE_INNER_CORNER)
                stable_dist = math.dist(L_inner_corner_for_dist, R_inner_corner_for_dist)
                if stable_dist == 0:
                    stable_dist = 1

                # --- 3. 눈동자 중심 (양 눈 iris 가로 좌표 평균) ---
                L_iris_h_points = [get_pixel_coords(i) for i in LEFT_IRIS_HORIZONTAL]
                center_left_x = sum([p[0] for p in L_iris_h_points]) // 2
                center_left_y = sum([p[1] for p in L_iris_h_points]) // 2

                R_iris_h_points = [get_pixel_coords(i) for i in RIGHT_IRIS_HORIZONTAL]
                center_right_x = sum([p[0] for p in R_iris_h_points]) // 2
                center_right_y = sum([p[1] for p in R_iris_h_points]) // 2

                avg_pupil_x = (center_left_x + center_right_x) / 2.0
                avg_pupil_y = (center_left_y + center_right_y) / 2.0

                # --- 4. 시선 Metric (정규화된 비율 값) ---
                current_metric_x = (avg_pupil_x - anchor_point[0]) / stable_dist
                current_metric_y = (avg_pupil_y - anchor_point[1]) / stable_dist

                # --- 5. 보정값과의 차이 (raw diff) ---
                diff_x_raw = current_metric_x - calibrated_metric_x
                diff_y_raw = current_metric_y - calibrated_metric_y

                # --- 6. EMA 적용으로 프레임 간 떨림 감소 ---
                if not ema_initialized:
                    # 첫 프레임은 그냥 현재 diff로 초기화
                    ema_diff_x = diff_x_raw
                    ema_diff_y = diff_y_raw
                    ema_initialized = True
                else:
                    # S_t = (1 - α) * S_{t-1} + α * X_t
                    ema_diff_x = (1 - EMA_ALPHA) * ema_diff_x + EMA_ALPHA * diff_x_raw
                    ema_diff_y = (1 - EMA_ALPHA) * ema_diff_y + EMA_ALPHA * diff_y_raw

                # 이제부터는 raw diff 대신 EMA 결과(ema_diff_x, ema_diff_y)를 사용
                diff_x = ema_diff_x
                diff_y = ema_diff_y

                # 좌우 판단
                if diff_x > GAZE_THRESHOLD_X:
                    gaze_direction_x = "Right"
                elif diff_x < -GAZE_THRESHOLD_X:
                    gaze_direction_x = "Left"
                else:
                    gaze_direction_x = "Center"

                # 상하 판단
                # 이미지 좌표계에서 y는 아래로 갈수록 + 이므로:
                # diff_y < 0 => 위쪽, diff_y > 0 => 아래쪽
                if diff_y < -GAZE_THRESHOLD_Y:
                    gaze_direction_y = "Up"
                elif diff_y > GAZE_THRESHOLD_Y:
                    gaze_direction_y = "Down"
                else:
                    gaze_direction_y = "Center"

            except Exception:
                pass

    # --- UI 텍스트 표시 (원래 UI 그대로) ---

    # 1줄: 좌우
    text_x = 50
    text_y = 50
    display_text_x = gaze_direction_x
    cv2.putText(image, display_text_x, (text_x, text_y),
                FONT, FONT_SCALE_MAIN, TEXT_COLOR, FONT_THICKNESS_MAIN, cv2.LINE_AA)

    # 2줄: 상하
    display_text_y = gaze_direction_y
    cv2.putText(image, display_text_y, (text_x, text_y + 40),
                FONT, FONT_SCALE_MAIN, TEXT_COLOR, FONT_THICKNESS_MAIN, cv2.LINE_AA)

    # 보정 안내 텍스트
    calib_instruction = "Press 'c' to Calibrate Center"
    calib_text_color = CALIB_COLOR_NOT
    if is_calibrated:
        calib_instruction = "Calibrated"
        calib_text_color = CALIB_COLOR_DONE

    calib_text_size = cv2.getTextSize(
        calib_instruction, FONT, FONT_SCALE_CALIB, FONT_THICKNESS_CALIB
    )[0]
    calib_text_x = (image_width - calib_text_size[0]) // 2
    calib_text_y = image_height - 30

    cv2.putText(image, calib_instruction, (calib_text_x, calib_text_y),
                FONT, FONT_SCALE_CALIB, calib_text_color, FONT_THICKNESS_CALIB, cv2.LINE_AA)

    # 키 입력 처리
    key = cv2.waitKey(5) & 0xFF
    if key == ord('q'):
        break
    elif key == ord('c'):
        # 가운데 보고 있을 때 'c'를 눌러 기준점 보정
        is_calibrated = True
        calibrated_metric_x = current_metric_x
        calibrated_metric_y = current_metric_y

        # 보정 시 EMA도 리셋해줘야 튀지 않음
        ema_initialized = False

        print(f"--- Center Calibrated! (X: {calibrated_metric_x:.3f}, Y: {calibrated_metric_y:.3f}) ---")

    cv2.imshow('Gaze Tracker (Left/Right + Up/Down)', image)

cap.release()
cv2.destroyAllWindows()
