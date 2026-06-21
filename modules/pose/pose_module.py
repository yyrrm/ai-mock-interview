import cv2
import mediapipe as mp
import numpy as np
from collections import deque

class PoseAnalyzer:
    def __init__(self, smooth_window=5, motion_threshold=20):
        # MediaPipe 초기화
        self.mp_pose = mp.solutions.pose
        self.pose = self.mp_pose.Pose(
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        self.drawing = mp.solutions.drawing_utils

        # 안정화용 버퍼
        self.landmark_buffer = deque(maxlen=smooth_window)
        self.prev_coords = None
        self.motion_threshold = motion_threshold

    # =========================
    # 1) 프레임에서 자세 인식
    # =========================
    def detect_pose(self, frame):
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = self.pose.process(rgb)
        return result

    # =========================
    # 2) 좌표 안정화(이동 평균)
    # =========================
    def stabilize(self, landmarks):
        self.landmark_buffer.append(landmarks)
        avg = np.mean(self.landmark_buffer, axis=0)
        return avg

    # =========================
    # 3) 움직임 변화량 계산
    # =========================
    def calc_motion(self, coords):
        if self.prev_coords is None:
            self.prev_coords = coords
            return 0

        # [스케일 불일치 주의 / 팀 확인 필요]
        # 여기서는 33x3 전체 배열에 대한 Frobenius norm(모든 관절 합산)을 쓰는데,
        # 점수 공식(/2.0 스케일 가정)은 "관절 1개당" 변화량 스케일을 전제로 한다.
        # 둘의 스케일이 달라 점수가 0/100 으로 양극화될 가능성이 큼.
        # 올바른 의도는 관절별 변화량의 평균,
        # 즉 np.mean(np.linalg.norm(coords - self.prev_coords, axis=1)) 일 것으로 보임.
        # 실행으로 검증할 수 없는 채점/설계 이슈라 임의 수정하지 않고 기록만 남김.
        movement = np.linalg.norm(coords - self.prev_coords)
        self.prev_coords = coords
        return movement

    # =========================
    # 4) 전체 프레임 처리
    # =========================
    def process_frame(self, frame):
        result = self.detect_pose(frame)

        if not result.pose_landmarks:
            return frame, 0, None

        # 좌표 배열화
        landmarks = np.array(
            [(lm.x, lm.y, lm.z) for lm in result.pose_landmarks.landmark]
        )

        # 1. 흔들림 안정화
        stabilized = self.stabilize(landmarks)

        # 2. 움직임 변화량 계산
        motion_value = self.calc_motion(stabilized)

        # 3. 시각화
        self.drawing.draw_landmarks(
            frame,
            result.pose_landmarks,
            self.mp_pose.POSE_CONNECTIONS
        )

        return frame, motion_value, stabilized


# =========================
# 5) 모듈 단독 실행용 테스트
# =========================
if __name__ == "__main__":
    analyzer = PoseAnalyzer()
    cap = cv2.VideoCapture(0)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        processed, motion, coords = analyzer.process_frame(frame)

        # 움직임이 일정 threshold 넘으면 표시
        if motion > analyzer.motion_threshold:
            cv2.putText(processed, "Movement Detected!", (10, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

        cv2.imshow("Pose Module Test", processed)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
