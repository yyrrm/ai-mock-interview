from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

import numpy as np


@dataclass
class PoseEvalResult:
    metrics: Dict[str, object]
    scores: Dict[str, float]
    total_score: float
    feedback: str


def _deg(rad: float) -> float:
    return float(rad) * 180.0 / np.pi


def _score_tilt(abs_deg: float) -> float:
    if abs_deg <= 5.0:
        return 100.0
    if abs_deg <= 10.0:
        return 70.0
    return 40.0


def _score_sway(mean_disp: float) -> float:
    # mean_disp is normalized coordinate displacement per frame
    if mean_disp < 0.004:
        return 100.0
    if mean_disp < 0.010:
        return 70.0
    return 40.0


def _score_gesture(gestures_per_min: float) -> float:
    if 2.0 <= gestures_per_min <= 8.0:
        return 100.0
    if gestures_per_min <= 1.0 or gestures_per_min >= 10.0:
        return 40.0
    return 70.0


class PoseEvaluator:
    """
    평가지표 기반 자세 평가 모듈

    입력 데이터:
    - MediaPipe Pose로 추출된 관절 좌표
    - numpy 배열 형태 (33, 3)
    - 정규화된 좌표값 (x, y, z)

    본 모듈은 관절 좌표를 기반으로
    상체 기울기, 흔들림, 손동작 빈도를 계산하여
    자세 점수 및 피드백을 생성한다.
    """

    # MediaPipe Pose landmark indices
    L_SHOULDER = 11
    R_SHOULDER = 12
    L_WRIST = 15
    R_WRIST = 16
    L_HIP = 23
    R_HIP = 24

    def __init__(self, gesture_move_threshold: float = 0.020, gesture_cooldown_sec: float = 0.45):
        self.prev_center: Optional[np.ndarray] = None
        self.sway_sum = 0.0
        self.sway_n = 0

        self.session_start = time.time()
        self.gesture_count = 0
        self._last_gesture_ts = 0.0
        self.gesture_move_threshold = float(gesture_move_threshold)
        self.gesture_cooldown_sec = float(gesture_cooldown_sec)

        self.prev_wrists: Optional[Tuple[np.ndarray, np.ndarray]] = None

    def reset(self):
        self.__init__(
            gesture_move_threshold=self.gesture_move_threshold,
            gesture_cooldown_sec=self.gesture_cooldown_sec,
        )

    def update(self, coords: Optional[np.ndarray]) -> Optional[PoseEvalResult]:
        """
    최신 관절 좌표를 입력받아 내부 상태를 갱신하고
    현재 프레임 기준의 자세 평가 결과를 반환한다.

    - 관절 좌표가 None일 경우(인식 실패),
      평가를 수행하지 않고 None을 반환한다.
    """
        if coords is None or not isinstance(coords, np.ndarray) or coords.shape[0] < 25:
            return None

        # ---- tilt (shoulders) ----
        l_sh = coords[self.L_SHOULDER][:2]
        r_sh = coords[self.R_SHOULDER][:2]
        dy = float(r_sh[1] - l_sh[1])
        dx = float(r_sh[0] - l_sh[0])
        theta = _deg(np.arctan2(dy, dx))
        # when perfectly horizontal, dy=0 -> theta=0
        abs_theta = abs(theta)

        # ---- sway (upper body center) ----
        l_hip = coords[self.L_HIP][:2]
        r_hip = coords[self.R_HIP][:2]
        center = (l_sh + r_sh + l_hip + r_hip) / 4.0

        if self.prev_center is not None:
            disp = float(np.linalg.norm(center - self.prev_center))
            self.sway_sum += disp
            self.sway_n += 1
        self.prev_center = center

        mean_sway = (self.sway_sum / self.sway_n) if self.sway_n > 0 else 0.0

        # ---- gesture counting (wrists movement bursts) ----
        lw = coords[self.L_WRIST][:2]
        rw = coords[self.R_WRIST][:2]
        now = time.time()
        if self.prev_wrists is not None:
            prev_lw, prev_rw = self.prev_wrists
            move = float(np.linalg.norm(lw - prev_lw) + np.linalg.norm(rw - prev_rw))
            if move >= self.gesture_move_threshold and (now - self._last_gesture_ts) >= self.gesture_cooldown_sec:
                self.gesture_count += 1
                self._last_gesture_ts = now
        self.prev_wrists = (lw, rw)

        elapsed_min = max((now - self.session_start) / 60.0, 1e-6)
        gestures_per_min = float(self.gesture_count) / elapsed_min

        # ---- scoring ----
        scores = {
            "tilt": _score_tilt(abs_theta),
            "sway": _score_sway(mean_sway),
            "gesture": _score_gesture(gestures_per_min),
        }
        total = 0.40 * scores["tilt"] + 0.35 * scores["sway"] + 0.25 * scores["gesture"]
        total = float(round(total, 1))

        metrics: Dict[str, object] = {
            "tilt_deg": round(abs_theta, 2),
            "sway_mean": round(mean_sway, 5),
            "gesture_count": int(self.gesture_count),
            "gestures_per_min": round(gestures_per_min, 2),
            "elapsed_min": round(elapsed_min, 2),
        }

        # ---- feedback ----
        fb = []
        if abs_theta > 10.0:
            fb.append("어깨가 한쪽으로 많이 기울어 보입니다. 상체를 중앙에 맞춰주세요.")
        elif abs_theta > 5.0:
            fb.append("상체가 약간 기울어져 있습니다. 화면 중앙을 기준으로 자세를 맞춰보세요.")

        if mean_sway >= 0.010:
            fb.append("상체 흔들림이 많아 긴장한 인상을 줄 수 있습니다. 고정 자세를 의식해보세요.")
        elif mean_sway >= 0.004:
            fb.append("상체 움직임이 조금 있습니다. 답변 중에는 상체를 안정적으로 유지해보세요.")

        if gestures_per_min <= 1.0:
            fb.append("손동작이 거의 없어 다소 경직돼 보일 수 있습니다. 적당한 제스처를 사용해보세요.")
        elif gestures_per_min >= 10.0:
            fb.append("손동작이 너무 잦아 산만해 보일 수 있습니다. 불필요한 움직임을 줄여보세요.")

        if not fb:
            fb.append("자세가 전반적으로 안정적입니다. 현재 상태를 유지해보세요.")

        return PoseEvalResult(metrics=metrics, scores=scores, total_score=total, feedback=" ".join(fb))
