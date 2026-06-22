from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class GazeEvalResult:
    metrics: Dict[str, object]
    scores: Dict[str, float]
    total_score: float
    feedback: str


def _lerp_score(x: float, full: float, zero: float) -> float:
    # x<=full → 100점, x>=zero → 0점, 사이는 선형 보간(부드러운 감점).
    if x <= full:
        return 100.0
    if x >= zero:
        return 0.0
    return 100.0 * (zero - x) / (zero - full)


def _score_centered(off: float) -> float:
    # off: 시선이 카메라(정면)에서 벗어난 정도(0=정면). 작을수록 좋다.
    # 블렌드셰이프 노이즈로 정면에서도 off 가 0 이 아니므로 ~0.22 까지는 만점으로 본다.
    return _lerp_score(off, full=0.22, zero=0.60)


def _score_stability(std: float) -> float:
    # std: 세션 동안 시선 방향의 표준편차(흔들림). 작을수록 안정적.
    return _lerp_score(std, full=0.10, zero=0.30)


class GazeEvaluator:
    """
    시선 평가 모듈 (브라우저 FaceLandmarker 의 eyeLook 블렌드셰이프 + 머리 yaw 기반)

    - eyeLook(In/Out/Up/Down) 계수로 '눈동자가 정면에서 벗어난 정도' 를,
    - 머리 좌우 회전(yaw, 브라우저가 코·얼굴 외곽 랜드마크로 계산) 으로
      '고개가 카메라에서 돌아간 정도' 를 합쳐 '시선이 카메라를 향하는지' 를 본다.

    프레임마다 update() 로 누적하고, summary() 에서
    평균 이탈(중심도)과 흔들림(안정성)을 합산해 0~100 점수를 만든다.
    데스크톱 iris 기반 시선과 1:1 대응은 아니나, 면접에서 핵심인
    "카메라(면접관)를 안정적으로 응시" 를 가볍게 평가하도록 설계했다.
    """

    def __init__(self):
        self._off_sum = 0.0
        self._off_sq_sum = 0.0
        self._n = 0
        self._total_sum = 0.0
        self._blink_sum = 0.0

    def reset(self):
        self.__init__()

    @staticmethod
    def _get(blend: Dict[str, float], key: str) -> float:
        try:
            v = float(blend.get(key, 0.0))
        except (TypeError, ValueError):
            return 0.0
        return min(1.0, max(0.0, v))

    def _eye_deviation(self, blend: Dict[str, float]) -> float:
        # 좌우 눈의 eyeLook 계수 평균. 정면 응시 시 모두 0 근처.
        keys = (
            "eyeLookInLeft", "eyeLookInRight",
            "eyeLookOutLeft", "eyeLookOutRight",
            "eyeLookUpLeft", "eyeLookUpRight",
            "eyeLookDownLeft", "eyeLookDownRight",
        )
        return sum(self._get(blend, k) for k in keys) / float(len(keys))

    def update(
        self,
        blend: Optional[Dict[str, float]],
        yaw: Optional[float] = None,
        now: Optional[float] = None,
    ) -> Optional[GazeEvalResult]:
        """블렌드셰이프 + 머리 yaw 한 프레임을 받아 시선 점수를 계산/누적한다.

        - yaw: 머리 좌우 회전 근사값(브라우저 계산, 정면=0, 대략 -1~1).
        - 얼굴 미검출(blend 없음) 시 None.
        """
        if not isinstance(blend, dict) or not blend:
            return None

        eye_dev = self._eye_deviation(blend)
        try:
            head_yaw = abs(float(yaw)) if yaw is not None else 0.0
        except (TypeError, ValueError):
            head_yaw = 0.0
        head_yaw = min(1.0, head_yaw)

        # 눈동자 이탈(주) + 고개 회전(보조) 을 합쳐 카메라 이탈도를 만든다.
        # eye_dev 는 8개 eyeLook 평균이라 한 방향만 봐도 값이 희석된다 → 1.5배 보정.
        # (과거 2.0배는 정면 응시에서도 off 가 0.15 임계를 넘겨 70점에 갇히는 원인이었다.)
        off = 0.7 * (eye_dev * 1.5) + 0.3 * head_yaw
        off = min(1.0, off)

        blink = (self._get(blend, "eyeBlinkLeft") + self._get(blend, "eyeBlinkRight")) / 2.0

        centered_score = _score_centered(off)

        self._off_sum += off
        self._off_sq_sum += off * off
        self._blink_sum += blink
        self._n += 1
        self._total_sum += centered_score

        scores = {"centered": centered_score}
        metrics = {"eye_dev": round(eye_dev, 3), "head_yaw": round(head_yaw, 3), "off": round(off, 3)}
        return GazeEvalResult(metrics=metrics, scores=scores, total_score=centered_score, feedback="")

    def summary(self) -> Optional[GazeEvalResult]:
        """세션 평균 중심도 + 흔들림(안정성) 을 합산한 최종 시선 점수/피드백."""
        if self._n == 0:
            return None

        mean_off = self._off_sum / self._n
        var = max(0.0, self._off_sq_sum / self._n - mean_off * mean_off)
        std = math.sqrt(var)
        blink_mean = self._blink_sum / self._n

        centered_score = _score_centered(mean_off)
        stability_score = _score_stability(std)
        total = float(round(0.6 * centered_score + 0.4 * stability_score, 1))

        fb: List[str] = []
        if mean_off > 0.45:
            fb.append("시선이 카메라에서 자주 벗어납니다. 화면(면접관)을 정면으로 바라보세요.")
        elif mean_off > 0.22:
            fb.append("시선이 가끔 한쪽으로 쏠립니다. 카메라 렌즈를 기준으로 응시해보세요.")

        if std > 0.20:
            fb.append("시선 흔들림이 큰 편입니다. 답변 중에는 시선을 안정적으로 유지해보세요.")
        elif std > 0.10:
            fb.append("시선이 조금 분산됩니다. 한 곳을 차분히 응시해보세요.")

        if not fb:
            fb.append("카메라를 안정적으로 응시했습니다. 좋은 아이컨택입니다.")

        scores = {"centered": centered_score, "stability": stability_score}
        metrics = {
            "off_mean": round(mean_off, 3),
            "off_std": round(std, 3),
            "blink_mean": round(blink_mean, 3),
            "frames": self._n,
        }
        return GazeEvalResult(metrics=metrics, scores=scores, total_score=total, feedback=" ".join(fb))
