from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from modules.evaluation.audio_metrics import compute_audio_stats
from modules.evaluation.text_metrics import wer, cer


@dataclass
class VoiceEvalResult:
    metrics: Dict[str, object]
    scores: Dict[str, Optional[float]]
    total_score: float
    feedback: str


def _score_speed(wpm: float) -> float:
    if 130 <= wpm <= 180:
        return 100.0
    if 100 <= wpm < 130 or 180 < wpm <= 220:
        return 70.0
    return 40.0


def _score_error_rate(error_ratio: float) -> float:
    # 오류율(0.0~1.0) → 점수. WER/CER 공통으로 사용한다.
    p = error_ratio * 100.0
    if p <= 10.0:
        return 100.0
    if p <= 20.0:
        return 70.0
    return 40.0


def _score_clarity(confidence: float) -> float:
    # STT 신뢰도(0~1) 기반 발화 명료도 — 기준 문장이 없는 자유 답변용.
    # 또박또박 말하면 인식기 신뢰도가 높고, 웅얼거리면 낮아진다.
    if confidence >= 0.90:
        return 100.0
    if confidence >= 0.75:
        return 70.0
    return 40.0


def _score_volume(delta_db: float, std_db: float) -> float:
    # rubric 기준은 “개인 기준 대비 변화”.
    # 여기선 baseline 대비 delta_db로 근사 + 클립 내부 흔들림(std_db)을 보조로 사용.
    if -3.0 <= delta_db <= 6.0 and std_db <= 4.0:
        return 100.0
    if -6.0 <= delta_db <= 9.0 and std_db <= 7.0:
        return 70.0
    return 40.0


def _score_silence(silence_per_min: float) -> float:
    if 0.0 <= silence_per_min <= 2.0:
        return 100.0
    if silence_per_min <= 5.0:
        return 70.0
    return 40.0


class VoiceEvaluator:
    """
    평가지표 기반 음성 평가 모듈

    - 입력: 음성 파일(wav), STT 변환 텍스트
    - 출력: 0~100 점수 및 간단한 피드백 문장

    ※ 발음 정확도(WER)는 기준 스크립트가 필요하며,
     기준 스크립트가 없을 경우 해당 지표를 제외하고
      나머지 지표로 점수를 재계산한다.
    """


    def __init__(self):
        self._baseline_db: Optional[float] = None

    def _update_baseline(self, mean_db: float, alpha: float = 0.15) -> float:
        if self._baseline_db is None:
            self._baseline_db = mean_db
        else:
            self._baseline_db = (1 - alpha) * self._baseline_db + alpha * mean_db
        return self._baseline_db

    def evaluate(
        self,
        wav_path: str,
        stt_text: str,
        reference_script: Optional[str] = None,
        stt_confidence: Optional[float] = None,
    ) -> VoiceEvalResult:

        reference_script = reference_script or os.getenv("VOICE_REFERENCE_SCRIPT")

        audio = compute_audio_stats(wav_path)
        duration_min = max(audio.duration_sec / 60.0, 1e-6)

        # ---- metrics ----
        word_count = len((stt_text or "").strip().split())
        wpm = float(word_count) / duration_min

        baseline_db = self._update_baseline(audio.mean_db)
        delta_db = float(audio.mean_db - baseline_db)

        silence_per_min = float(audio.silence_segments_2s) / duration_min

        # ---- 발음(CER/WER) / 명료도(STT 신뢰도) ----
        # 팀 합의:
        #  - 기준 문장이 있으면 발음 점수는 글자 단위 CER 로 낸다(주 지표).
        #    한국어는 띄어쓰기가 불안정해 단어 단위 WER 보다 CER 이 공정함.
        #    WER 도 함께 계산해 metrics 에 '참고(비교)' 값으로만 남긴다.
        #  - 기준 문장이 없는 자유 답변은 confidence 로 명료도를 추정하되,
        #    발음+음량+잡음+마이크가 섞인 값이라 '보조 지표'(낮은 가중치)로만 사용.
        #    (음량/잡음은 이미 volume/silence 로 따로 보므로 이중 계산도 피한다.)
        wer_ratio: Optional[float] = None
        cer_ratio: Optional[float] = None
        clarity_method: Optional[str] = None   # "cer" | "confidence" | None
        pronunciation_score: Optional[float] = None  # CER 기반 (주 지표)
        clarity_score: Optional[float] = None        # 신뢰도 기반 (보조 지표)
        if reference_script:
            cer_ratio = float(cer(reference_script, stt_text))
            wer_ratio = float(wer(reference_script, stt_text))  # 참고용
            pronunciation_score = _score_error_rate(cer_ratio)
            clarity_method = "cer"
        elif stt_confidence is not None:
            clarity_score = _score_clarity(stt_confidence)
            clarity_method = "confidence"

        metrics: Dict[str, object] = {
            "duration_sec": round(audio.duration_sec, 2),
            "wpm": round(wpm, 1),
            "mean_db": round(audio.mean_db, 2),
            "std_db": round(audio.std_db, 2),
            "baseline_db": round(baseline_db, 2),
            "delta_db": round(delta_db, 2),
            "silence_segments_2s": int(audio.silence_segments_2s),
            "silence_per_min": round(silence_per_min, 2),
            "cer": (round(cer_ratio * 100.0, 2) if cer_ratio is not None else None),
            "wer": (round(wer_ratio * 100.0, 2) if wer_ratio is not None else None),  # 참고용
            "stt_confidence": (round(float(stt_confidence), 3) if stt_confidence is not None else None),
            "clarity_method": clarity_method,
        }

        # ---- scores per metric ----
        # pronunciation(WER, 주 지표)과 clarity(신뢰도, 보조 지표)는 동시에 켜지지 않는다.
        scores: Dict[str, Optional[float]] = {
            "speed": _score_speed(wpm),
            "volume": _score_volume(delta_db, audio.std_db),
            "silence": _score_silence(silence_per_min),
            "pronunciation": pronunciation_score,   # CER (기준 문장 있을 때만)
            "clarity": clarity_score,                # STT 신뢰도 (자유 답변일 때만)
        }

        weights = {
            "pronunciation": 0.35,  # CER — 주 지표
            "speed": 0.25,
            "volume": 0.20,
            "silence": 0.20,
            "clarity": 0.10,        # 신뢰도 — 보조 지표(CER보다 낮게)
        }

        # 사용 불가한 지표(None)는 빼고 가중치를 재정규화한다.
        # → 기준 문장 있으면 CER 포함 4지표, 자유 답변이면 clarity 포함 4지표,
        #   둘 다 없으면 속도·음량·침묵 3지표만으로 합산.
        active = {k: v for k, v in weights.items() if scores.get(k) is not None}
        wsum = sum(active.values()) if active else 1.0
        active = {k: v / wsum for k, v in active.items()}

        total = 0.0
        for k, w in active.items():
            total += float(scores[k]) * float(w)

        total = float(round(total, 1))

        # ---- feedback ----
        feedback_parts = []
        if wpm > 220:
            feedback_parts.append("말 속도가 너무 빠릅니다(220WPM 초과). 조금 천천히 말해보세요.")
        elif wpm < 100:
            feedback_parts.append("말 속도가 느린 편입니다(100WPM 미만). 핵심을 또렷하게 이어 말해보세요.")
        elif not (130 <= wpm <= 180):
            feedback_parts.append("말 속도가 약간 치우쳐 있습니다. 130~180WPM 범위를 목표로 해보세요.")

        if silence_per_min >= 6:
            feedback_parts.append("답변 중 2초 이상 침묵이 잦습니다. 연결어(예: '우선…')로 흐름을 이어보세요.")
        elif silence_per_min >= 3:
            feedback_parts.append("침묵 구간이 조금 있습니다. 문장 연결을 의식해보세요.")

        if not (-3.0 <= delta_db <= 6.0):
            feedback_parts.append("목소리 크기 변화가 커서 전달력이 떨어질 수 있습니다. 일정한 음량을 유지해보세요.")
        elif audio.std_db > 7.0:
            feedback_parts.append("음량이 들쭉날쭉합니다. 문장 단위로 호흡을 안정화해보세요.")

        if clarity_method == "confidence" and stt_confidence is not None:
            # confidence 는 발음 외 소음·마이크 영향도 받으므로 문구도 그에 맞춘다.
            if stt_confidence < 0.75:
                feedback_parts.append("음성 인식 신뢰도가 낮습니다. 더 또렷하게 말하거나 주변 소음·마이크 상태를 확인해보세요.")
            elif stt_confidence < 0.90:
                feedback_parts.append("대체로 또렷하지만 발음이 약간 뭉개지거나 주변 잡음이 섞일 수 있습니다.")

        # 발음 피드백은 점수 기준인 CER 로 판단한다.
        if cer_ratio is not None:
            if cer_ratio >= 0.20:
                feedback_parts.append("발음 오류가 다소 많습니다. 또박또박 끊어 말하는 연습이 필요합니다.")
            elif cer_ratio >= 0.10:
                feedback_parts.append("발음 정확도가 조금 아쉽습니다. 자주 틀리는 발음을 반복 연습해보세요.")

        if not feedback_parts:
            feedback_parts.append("전반적으로 전달력이 안정적입니다. 현재 템포를 유지해보세요.")

        return VoiceEvalResult(
            metrics=metrics,
            scores=scores,
            total_score=total,
            feedback=" ".join(feedback_parts),
        )
