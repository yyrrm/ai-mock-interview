from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict, Optional, Tuple

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
    # 적당한 제스처(분당 2~8회)가 가장 자연스럽다.
    # 단, 면접에서는 손을 차분히 두는 경우가 많으므로 '제스처 없음'을 과하게
    # 깎지 않는다(손을 안 움직여도 80점). 반대로 산만할 만큼 잦으면(분당 12회 이상)
    # 감점한다.
    if 2.0 <= gestures_per_min <= 8.0:
        return 100.0
    if gestures_per_min < 2.0:
        return 80.0           # 손동작이 적거나 없음 — 무난
    if gestures_per_min < 12.0:
        return 70.0           # 다소 많음
    return 45.0               # 너무 잦아 산만


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

    # 흔들림(sway)은 '최근 구간'의 평균만 본다. 세션 전체 누적 평균을 쓰면 시간이
    # 지날수록 분모가 커져 순간 움직임이 희석되고, 결국 점수가 한 값에 굳어버린다
    # ('자세 점수가 74에서 안 변한다'의 주원인). 최근 SWAY_WINDOW 프레임만 보면
    # 지금 움직이면 점수가 즉시 반응한다. 웹은 ~10fps(300ms 배치)이므로 24프레임≈수 초.
    SWAY_WINDOW = 24

    # 제스처 빈도를 환산할 최근 시간창(초). 이 안의 제스처 수를 분당으로 환산한다.
    GESTURE_WINDOW_SEC = 15.0

    def __init__(self, gesture_move_threshold: float = 0.020, gesture_cooldown_sec: float = 0.45):
        self.prev_center: Optional[np.ndarray] = None
        # 최근 프레임 간 이동량(변위)을 담는 슬라이딩 윈도우.
        self.sway_window: Deque[float] = deque(maxlen=self.SWAY_WINDOW)

        self.session_start = time.time()
        self._anchored = False  # 첫 update 시점으로 session_start 를 보정했는지
        self.gesture_count = 0   # 세션 누적(메트릭 표시·summary 용)
        self._last_gesture_ts = 0.0
        # 제스처도 '최근 구간'만 본다. 최근 GESTURE_WINDOW_SEC 초 안에 일어난
        # 제스처 타임스탬프만 남겨 분당 빈도로 환산 → 지금 손을 움직이면 빈도가
        # 즉시 오르고, 멈추면 빠르게 떨어진다(누적 평균은 둘 다 반영이 느리다).
        self.gesture_ts: Deque[float] = deque()
        self.gesture_move_threshold = float(gesture_move_threshold)
        self.gesture_cooldown_sec = float(gesture_cooldown_sec)

        self.prev_wrists: Optional[Tuple[np.ndarray, np.ndarray]] = None

    def reset(self):
        self.__init__(
            gesture_move_threshold=self.gesture_move_threshold,
            gesture_cooldown_sec=self.gesture_cooldown_sec,
        )

    def update(self, coords: Optional[np.ndarray], now: Optional[float] = None) -> Optional[PoseEvalResult]:
        """
    최신 관절 좌표를 입력받아 내부 상태를 갱신하고
    현재 프레임 기준의 자세 평가 결과를 반환한다.

    - 관절 좌표가 None일 경우(인식 실패),
      평가를 수행하지 않고 None을 반환한다.
    - now: 프레임 시각(초). 미지정 시 time.time() 사용(데스크톱 실시간 경로).
      웹처럼 프레임을 모아 한꺼번에 처리할 때는 각 프레임의 실제 시각을 주입해야
      흔들림(프레임 간격)과 제스처(쿨다운) 계산이 어긋나지 않는다.
    """
        if coords is None or not isinstance(coords, np.ndarray) or coords.shape[0] < 25:
            return None

        if now is None:
            now = time.time()
        # 첫 프레임 시각을 세션 시작으로 고정 → 경과 시간/제스처 빈도가 정확해진다.
        if not self._anchored:
            self.session_start = now
            self._anchored = True

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
            self.sway_window.append(disp)
        self.prev_center = center

        # 최근 구간 평균만 사용 → 지금 움직이면 즉시 점수에 반영된다.
        mean_sway = (sum(self.sway_window) / len(self.sway_window)) if self.sway_window else 0.0

        # ---- gesture counting (wrists movement bursts) ----
        lw = coords[self.L_WRIST][:2]
        rw = coords[self.R_WRIST][:2]
        if self.prev_wrists is not None:
            prev_lw, prev_rw = self.prev_wrists
            move = float(np.linalg.norm(lw - prev_lw) + np.linalg.norm(rw - prev_rw))
            if move >= self.gesture_move_threshold and (now - self._last_gesture_ts) >= self.gesture_cooldown_sec:
                self.gesture_count += 1
                self._last_gesture_ts = now
                self.gesture_ts.append(now)
        self.prev_wrists = (lw, rw)

        # 최근 시간창 밖의 제스처 타임스탬프는 버린다(현재 빈도만 반영).
        win = self.GESTURE_WINDOW_SEC
        while self.gesture_ts and (now - self.gesture_ts[0]) > win:
            self.gesture_ts.popleft()
        # 세션 초반(경과<창)에는 실제 경과 시간으로 환산해 빈도가 과대평가되지 않게 한다.
        elapsed_sec = max(now - self.session_start, 1e-6)
        window_sec = min(win, elapsed_sec)
        gestures_per_min = len(self.gesture_ts) / (window_sec / 60.0)

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
            "elapsed_min": round(elapsed_sec / 60.0, 2),
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
