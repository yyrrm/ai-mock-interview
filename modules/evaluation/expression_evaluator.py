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
    # 찡그림(frown)+미간 주름(browDown) 합으로 본 긴장/부정 인상.
    if tension <= 0.10:
        return 100.0
    if tension <= 0.25:
        return 70.0
    return 40.0


class ExpressionEvaluator:
    """
    표정 평가 모듈 (브라우저 MediaPipe FaceLandmarker 블렌드셰이프 기반)

    입력: ARKit 스타일 블렌드셰이프 계수 dict ({name: 0~1}).
    - 미소(mouthSmile L/R) 로 자연스러운 표정 여부를,
    - 찡그림(mouthFrown)·미간(browDown) 으로 긴장/부정 인상을 추정해
      0~100 자신감(표정) 점수와 피드백을 만든다.

    데스크톱의 py-feat 감정 인식과 1:1 대응은 아니지만, 면접 맥락에서
    중요한 "자연스럽고 안정적인 표정" 을 가볍게 평가하도록 설계했다.
    PoseEvaluator 와 동일하게 프레임마다 update() 로 누적하고
    summary() 로 세션 평균/피드백을 돌려준다.
    """

    def __init__(self):
        self._smile_sum = 0.0
        self._tension_sum = 0.0
        self._n = 0
        self._total_sum = 0.0
        # 프레임별 세부 점수의 합. summary() 의 scores 를 이 평균으로 내야
        # total_score(프레임 점수 평균)와 같은 기준이 되어 서로 일치한다.
        # (raw값을 먼저 평균낸 뒤 채점하면 임계값 비선형성 때문에 total 과 어긋난다.)
        self._smile_score_sum = 0.0
        self._tension_score_sum = 0.0

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

        tension = frown + 0.7 * brow_down

        smile_score = _score_smile(smile)
        tension_score = _score_tension(tension)
        total = 0.5 * smile_score + 0.5 * tension_score
        total = float(round(total, 1))

        self._smile_sum += smile
        self._tension_sum += tension
        self._smile_score_sum += smile_score
        self._tension_score_sum += tension_score
        self._total_sum += total
        self._n += 1

        scores = {"smile": smile_score, "tension": tension_score}
        metrics = {
            "smile": round(smile, 3),
            "tension": round(tension, 3),
        }
        return ExpressionEvalResult(metrics=metrics, scores=scores, total_score=total, feedback="")

    def summary(self) -> Optional[ExpressionEvalResult]:
        """세션 동안 누적한 표정 통계의 평균 점수 + 피드백."""
        if self._n == 0:
            return None

        smile = self._smile_sum / self._n
        tension = self._tension_sum / self._n
        avg_total = float(round(self._total_sum / self._n, 1))

        # scores 는 프레임별 점수의 평균 → total_score(0.5*smile+0.5*tension 의 평균)와
        # 같은 기준이라 scores 를 가중합하면 total 과 일치한다.
        # raw 평균(smile/tension)은 아래 피드백 임계값 판단에만 쓴다.
        scores = {
            "smile": round(self._smile_score_sum / self._n, 1),
            "tension": round(self._tension_score_sum / self._n, 1),
        }

        fb: List[str] = []
        if tension > 0.25:
            fb.append("표정에 긴장(찡그림·미간 주름)이 자주 보입니다. 미간을 펴고 편안한 표정을 의식해보세요.")
        elif tension > 0.10:
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
            "frames": self._n,
        }
        return ExpressionEvalResult(metrics=metrics, scores=scores, total_score=avg_total, feedback=" ".join(fb))
