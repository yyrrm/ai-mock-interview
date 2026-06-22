import cv2
import mediapipe as mp
import math

class GazeTracker:
    def __init__(self):
        # MediaPipe FaceMesh 초기화
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

        # ---------------------------------------------------------
        # [변수명 유지] 상수 및 설정값
        # ---------------------------------------------------------

        # 1. '안정적인' 랜드마크 (기준점)
        self.STABLE_ANCHOR_POINT = 6

        # 정규화(크기) 계산을 위한 '안쪽 눈꼬리'
        self.LEFT_EYE_INNER_CORNER = 33
        self.RIGHT_EYE_INNER_CORNER = 362

        # 3. 눈동자(Iris) 랜드마크
        self.LEFT_IRIS_HORIZONTAL = [477, 475]
        self.RIGHT_IRIS_HORIZONTAL = [470, 472]

        # 4. 깜빡임(EAR) 계산용 눈 랜드마크
        self.LEFT_EYE_EAR_IDX = [159, 145, 33, 133]
        self.RIGHT_EYE_EAR_IDX = [386, 374, 362, 263]

        # 깜빡임 임계값 초기설정
        self.BLINK_THRESHOLD = 0.18

        # --- 보정(Calibration) 관련 변수 ---
        self.is_calibrated = False
        self.calibrated_metric_x = 0.0
        self.calibrated_metric_y = 0.0
        self.current_metric_x = 0.0
        self.current_metric_y = 0.0

        # --- EMA(지수 이동 평균) 설정 ---
        self.EMA_ALPHA = 0.25
        self.ema_diff_x = 0.0
        self.ema_diff_y = 0.0
        self.ema_initialized = False

        # 시선 판단을 위한 임계값
        self.GAZE_THRESHOLD_X = 0.03
        self.GAZE_THRESHOLD_Y = 0.015

        # 텍스트 관련 설정
        self.FONT = cv2.FONT_HERSHEY_SIMPLEX
        self.FONT_SCALE_MAIN = 1
        self.FONT_THICKNESS_MAIN = 2
        self.FONT_SCALE_CALIB = 1
        self.FONT_THICKNESS_CALIB = 2
        self.TEXT_COLOR = (0, 255, 0)
        self.CALIB_COLOR_NOT = (0, 0, 255)
        self.CALIB_COLOR_DONE = (0, 255, 0)

        # 상태 변수
        self.gaze_direction_x = "Center"
        self.gaze_direction_y = "Center"
        self.is_blinking = False
        self.current_avg_ear = 0.0

    def _get_pixel_coords(self, landmarks, index, w, h):
        lm = landmarks[index]
        return int(lm.x * w), int(lm.y * h)

    def _get_ear(self, landmarks, indices, w, h):
        top = self._get_pixel_coords(landmarks, indices[0], w, h)
        bot = self._get_pixel_coords(landmarks, indices[1], w, h)
        in_ = self._get_pixel_coords(landmarks, indices[2], w, h)
        out = self._get_pixel_coords(landmarks, indices[3], w, h)
        vert = math.dist(top, bot)
        horiz = math.dist(in_, out)
        return vert / horiz if horiz > 0 else 0

    def process_frame(self, image):
        """
        메인 로직: 이미지를 받아서 분석하고, 그림을 그려서 돌려줌
        """
        image.setflags(write=False)
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        #image_rgb = cv2.flip(image_rgb, 1)
        results = self.face_mesh.process(image_rgb)
        image.setflags(write=True)
        image = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)

        image_height, image_width, _ = image.shape

        if results.multi_face_landmarks:
            for face_landmarks in results.multi_face_landmarks:
                landmarks = face_landmarks.landmark

                try:
                    # --- [추가] 0. 깜빡임 감지 (EAR) ---
                    l_ear = self._get_ear(landmarks, self.LEFT_EYE_EAR_IDX, image_width, image_height)
                    r_ear = self._get_ear(landmarks, self.RIGHT_EYE_EAR_IDX, image_width, image_height)
                    self.current_avg_ear = (l_ear + r_ear) / 2.0

                    if self.current_avg_ear < self.BLINK_THRESHOLD:
                        self.is_blinking = True
                        # 눈을 감으면 시선 계산 건너뜀 (continue 대신 else로 분기 처리)
                    else:
                        self.is_blinking = False

                        # ---------------------------------------------
                        # 기존 시선 계산 로직
                        # ---------------------------------------------

                        # --- 1. Anchor (미간) ---
                        anchor_point = self._get_pixel_coords(landmarks, self.STABLE_ANCHOR_POINT, image_width,
                                                              image_height)

                        # --- 2. 정규화 기준 거리 ---
                        L_inner = self._get_pixel_coords(landmarks, self.LEFT_EYE_INNER_CORNER, image_width,
                                                         image_height)
                        R_inner = self._get_pixel_coords(landmarks, self.RIGHT_EYE_INNER_CORNER, image_width,
                                                         image_height)
                        stable_dist = math.dist(L_inner, R_inner)
                        if stable_dist == 0: stable_dist = 1

                        # --- 3. 눈동자 중심 ---
                        L_iris_pts = [self._get_pixel_coords(landmarks, i, image_width, image_height) for i in
                                      self.LEFT_IRIS_HORIZONTAL]
                        center_left_x = sum([p[0] for p in L_iris_pts]) // 2
                        center_left_y = sum([p[1] for p in L_iris_pts]) // 2

                        R_iris_pts = [self._get_pixel_coords(landmarks, i, image_width, image_height) for i in
                                      self.RIGHT_IRIS_HORIZONTAL]
                        center_right_x = sum([p[0] for p in R_iris_pts]) // 2
                        center_right_y = sum([p[1] for p in R_iris_pts]) // 2

                        avg_pupil_x = (center_left_x + center_right_x) / 2.0
                        avg_pupil_y = (center_left_y + center_right_y) / 2.0

                        # --- 4. 시선 Metric ---
                        curr_metric_x = (avg_pupil_x - anchor_point[0]) / stable_dist
                        curr_metric_y = (avg_pupil_y - anchor_point[1]) / stable_dist

                        # 보정(c키)을 위해 현재 값 저장
                        self.current_metric_x = curr_metric_x
                        self.current_metric_y = curr_metric_y

                        # --- 5. 보정값과의 차이 ---
                        diff_x_raw = curr_metric_x - self.calibrated_metric_x
                        diff_y_raw = curr_metric_y - self.calibrated_metric_y

                        # --- 6. EMA 적용 ---
                        if not self.ema_initialized:
                            self.ema_diff_x = diff_x_raw
                            self.ema_diff_y = diff_y_raw
                            self.ema_initialized = True
                        else:
                            self.ema_diff_x = (1 - self.EMA_ALPHA) * self.ema_diff_x + self.EMA_ALPHA * diff_x_raw
                            self.ema_diff_y = (1 - self.EMA_ALPHA) * self.ema_diff_y + self.EMA_ALPHA * diff_y_raw

                        diff_x = self.ema_diff_x
                        diff_y = self.ema_diff_y

                        # 좌우 판단
                        if diff_x > self.GAZE_THRESHOLD_X:
                            self.gaze_direction_x = "Right"
                        elif diff_x < -self.GAZE_THRESHOLD_X:
                            self.gaze_direction_x = "Left"
                        else:
                            self.gaze_direction_x = "Center"

                        # 상하 판단
                        if diff_y < -self.GAZE_THRESHOLD_Y:
                            self.gaze_direction_y = "Up"
                        elif diff_y > self.GAZE_THRESHOLD_Y:
                            self.gaze_direction_y = "Down"
                        else:
                            self.gaze_direction_y = "Center"

                except Exception:
                    pass

        # --- UI 텍스트 표시 (그리기 함수 호출) ---
        self._draw_ui(image, image_width, image_height)
        return image

    def _draw_ui(self, image, w, h):
        # 1줄: 좌우
        text_x = 50
        text_y = 50
        display_text_x = self.gaze_direction_x
        cv2.putText(image, display_text_x, (text_x, text_y),
                    self.FONT, self.FONT_SCALE_MAIN, self.TEXT_COLOR, self.FONT_THICKNESS_MAIN, cv2.LINE_AA)

        # 2줄: 상하
        display_text_y = self.gaze_direction_y
        cv2.putText(image, display_text_y, (text_x, text_y + 40),
                    self.FONT, self.FONT_SCALE_MAIN, self.TEXT_COLOR, self.FONT_THICKNESS_MAIN, cv2.LINE_AA)

        # 깜빡임 상태 표시
        if self.is_blinking:
            cv2.putText(image, "Blinking...", (text_x, text_y + 80),
                        self.FONT, 0.8, (0, 0, 255), 2, cv2.LINE_AA)

        # 보정 안내 텍스트
        calib_instruction = "Press 'c' to Calibrate Center"
        calib_text_color = self.CALIB_COLOR_NOT
        if self.is_calibrated:
            calib_instruction = "Calibrated"
            calib_text_color = self.CALIB_COLOR_DONE

        calib_text_size = \
        cv2.getTextSize(calib_instruction, self.FONT, self.FONT_SCALE_CALIB, self.FONT_THICKNESS_CALIB)[0]
        calib_text_x = (w - calib_text_size[0]) // 2
        calib_text_y = h - 30

        cv2.putText(image, calib_instruction, (calib_text_x, calib_text_y),
                    self.FONT, self.FONT_SCALE_CALIB, calib_text_color, self.FONT_THICKNESS_CALIB, cv2.LINE_AA)

        # 현재 EAR 임계값 표시
        thresh_msg = f"Limit: {self.BLINK_THRESHOLD:.3f}"
        cv2.putText(image, thresh_msg, (w - 200, 50), self.FONT, 0.7, (200, 200, 200), 2)

    def calibrate(self):
        """외부(main.py)에서 c키를 눌렀을 때 호출하는 함수"""
        self.is_calibrated = True
        self.calibrated_metric_x = self.current_metric_x
        self.calibrated_metric_y = self.current_metric_y
        self.ema_initialized = False

        # 눈 크기 자동 보정
        if self.current_avg_ear > 0.1:
            self.BLINK_THRESHOLD = self.current_avg_ear * 0.6  # 님 코드의 0.6 유지
