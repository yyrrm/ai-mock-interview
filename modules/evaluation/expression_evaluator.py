from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class ExpressionEvalResult:
    metrics: Dict[str, object]
    scores: Dict[str, float]
    total_score: float
    feedback: str


def _score_smile(smile: float) -> float:
    # 자연스러운 미소(살짝)가 가장 좋고, 무표정은 보통, 과한 표정은 약간 감점.
    if 0.05 <= smile <= 0.60:
        return 100.0
    if smile < 0.05:
        return 70.0   # 무표정 — 나쁘지 않지만 다소 경직돼 보일 수 있음
    return 80.0       # 0.60 초과 — 과하게 웃는 인상


def _score_tension(tension: float) -> float:
    # 찡그림(mouthFrown)·미간 내림(browDown)·눈썹 올림(browUp)·눈 찡그림(eyeSquint)
    # 을 합산한 긴장/부정 인상 점수.
    # 무표정(tension≈0)이 만점이고, 찌푸림이 강할수록 감점한다.
    # 단, 최소값을 55로 둔다(이전 30). 이전엔 미소가 만점(100)이어도 약간의
    # 긴장만 있으면 0.5*100 + 0.5*30 = 65 가 천장이 되어 '웃어도 65점에서
    # 안 올라가는' 문제가 있었다. 최소값을 올려 천장을 풀었다.
    if tension <= 0.04:
        return 100.0
    if tension <= 0.10:
        return 85.0
    if tension <= 0.18:
        return 70.0
    if tension <= 0.28:
        return 60.0
    return 55.0


class ExpressionEvaluator:
    """
    표정 평가 모듈 (브라우저 MediaPipe FaceLandmarker 블렌드셰이프 기반)

    입력: ARKit 스타일 블렌드셰이프 계수 dict ({name: 0~1}).
    - 미소(mouthSmile L/R) 로 자연스러운 표정 여부를,
    - 찡그림(mouthFrown)·미간 내림(browDown)·눈썹 올림(browUp)·눈 찡그림(eyeSquint)
      으로 긴장/부정 인상을 추정해
      0~100 자신감(표정) 점수와 피드백을 만든다.

    데스크톱의 py-feat 감정 인식과 1:1 대응은 아니지만, 면접 맥락에서
    중요한 "자연스럽고 안정적인 표정" 을 가볍게 평가하도록 설계했다.
    PoseEvaluator 와 동일하게 프레임마다 update() 로 누적하고
    summary() 로 세션 평균/피드백을 돌려준다.
    """

    def __init__(self):
        self._smile_sum = 0.0
        self._tension_sum = 0.0
        self._jaw_sum = 0.0
        self._n = 0
        self._total_sum = 0.0

    def reset(self):
        self.__init__()

    @staticmethod
    def _get(blend: Dict[str, float], key: str) -> float:
        try:
            v = float(blend.get(key, 0.0))
        except (TypeError, ValueError):
            return 0.0
        # 블렌드셰이프 계수는 0~1 범위. 이상치는 클램프.
        if v < 0.0:
            return 0.0
        if v > 1.0:
            return 1.0
        return v

    def update(self, blend: Optional[Dict[str, float]], now: Optional[float] = None) -> Optional[ExpressionEvalResult]:
        """블렌드셰이프 한 프레임을 받아 표정 점수를 계산하고 누적한다.

        blend 가 비어 있으면(얼굴 미검출) None 을 반환한다.
        """
        if not isinstance(blend, dict) or not blend:
            return None

        smile = (self._get(blend, "mouthSmileLeft") + self._get(blend, "mouthSmileRight")) / 2.0
        frown = (self._get(blend, "mouthFrownLeft") + self._get(blend, "mouthFrownRight")) / 2.0
        brow_down = (self._get(blend, "browDownLeft") + self._get(blend, "browDownRight")) / 2.0
        # 눈썹 올림(놀람·당황 인상): 안쪽/바깥쪽 모두 반영
        brow_up = (
            self._get(blend, "browInnerUp")
            + self._get(blend, "browOuterUpLeft")
            + self._get(blend, "browOuterUpRight")
        ) / 3.0
        # 눈 찡그림(긴장·찌푸림 보조 신호)
        eye_squint = (self._get(blend, "eyeSquintLeft") + self._get(blend, "eyeSquintRight")) / 2.0
        jaw_open = self._get(blend, "jawOpen")

        # 무표정에서 벗어나 부정/긴장 인상을 주는 눈썹·입·눈 움직임을 합산.
        # browDown(미간 내림) 가중치를 높이고, browUp(눈썹 올림)도 반영한다.
        # 단, 진짜 미소(뒤셴 미소)는 눈가가 자연스럽게 좁아져 eyeSquint 가 올라가는데,
        # 이를 '긴장'으로 오판하면 웃을수록 감점되는 모순이 생긴다. 그래서 미소가
        # 충분할 때(smile≥0.15)는 eyeSquint 를 긴장 신호에서 제외한다.
        squint_term = 0.0 if smile >= 0.15 else 0.5 * eye_squint
        tension = frown + brow_down + 0.6 * brow_up + squint_term

        smile_score = _score_smile(smile)
        tension_score = _score_tension(tension)
        # 미소 비중을 약간 높여(0.6) 자연스럽게 웃는 표정이 점수에 더 반영되게 한다.
        total = 0.6 * smile_score + 0.4 * tension_score
        total = float(round(total, 1))

        self._smile_sum += smile
        self._tension_sum += tension
        self._jaw_sum += jaw_open
        self._total_sum += total
        self._n += 1

        scores = {"smile": smile_score, "tension": tension_score}
        metrics = {
            "smile": round(smile, 3),
            "tension": round(tension, 3),
            "jaw_open": round(jaw_open, 3),
        }
        return ExpressionEvalResult(metrics=metrics, scores=scores, total_score=total, feedback="")

    def summary(self) -> Optional[ExpressionEvalResult]:
        """세션 동안 누적한 표정 통계의 평균 점수 + 피드백."""
        if self._n == 0:
            return None

        smile = self._smile_sum / self._n
        tension = self._tension_sum / self._n
        jaw = self._jaw_sum / self._n
        avg_total = float(round(self._total_sum / self._n, 1))

        scores = {"smile": _score_smile(smile), "tension": _score_tension(tension)}

        fb: List[str] = []
        if tension > 0.15:
            fb.append("표정에 긴장(찡그림·미간 주름·눈썹 움직임)이 자주 보입니다. 미간을 펴고 편안한 표정을 의식해보세요.")
        elif tension > 0.05:
            fb.append("이따금 긴장한 표정이 비칩니다. 답변 사이에 잠깐 힘을 빼보세요.")

        if smile < 0.05:
            fb.append("표정 변화가 거의 없어 다소 경직돼 보일 수 있습니다. 가벼운 미소를 곁들여보세요.")
        elif smile > 0.60:
            fb.append("미소가 다소 과한 편입니다. 자연스러운 정도로 조절해보세요.")

        if not fb:
            fb.append("자연스럽고 안정적인 표정을 잘 유지했습니다.")

        metrics = {
            "smile_mean": round(smile, 3),
            "tension_mean": round(tension, 3),
            "jaw_mean": round(jaw, 3),
            "frames": self._n,
        }
        return ExpressionEvalResult(metrics=metrics, scores=scores, total_score=avg_total, feedback=" ".join(fb))
