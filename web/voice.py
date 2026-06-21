"""
web/voice.py — 음성 분석 API (브라우저 Web Audio/Web Speech 지표 기반)

데스크톱은 마이크 WAV 를 Google STT + VoiceEvaluator 로 평가하지만, 웹에서는
브라우저가 직접 음량(dB)·침묵·발화 길이를 Web Audio API 로 계산하고(가능하면
Web Speech API 로 단어 수·인식 신뢰도까지) 한 번에 보낸다. 서버는 WAV 디코딩
없이 동일한 평가 루브릭(VoiceEvaluator.evaluate_metrics)으로 점수만 매긴다.

→ 별도의 STT 서버 키나 오디오 포맷 변환(webm→wav) 없이 localhost 에서 바로 동작.
"""
from flask import Blueprint, request, jsonify

from modules.evaluation.voice_evaluator import VoiceEvaluator

voice_bp = Blueprint("voice", __name__)

MIN_DURATION_SEC = 1.0  # 이보다 짧으면 평가 의미가 없어 점수를 내지 않는다


def _num(data, key, default=None):
    v = data.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    return float(v)


@voice_bp.post("/api/analyze/voice/end")
def analyze_voice_end():
    """브라우저가 모은 음성 지표로 발화 점수를 계산한다.

    JSON: {
      duration_sec, mean_db, std_db, silence_segments,
      baseline_db?(보정 음량), word_count?, stt_confidence?(0~1)
    }
    """
    data = request.get_json(silent=True) or {}

    duration_sec = _num(data, "duration_sec")
    mean_db = _num(data, "mean_db")
    std_db = _num(data, "std_db", 0.0)
    silence_segments = _num(data, "silence_segments", 0.0)

    if duration_sec is None or mean_db is None or duration_sec < MIN_DURATION_SEC:
        return jsonify({"ok": True, "score": None, "feedback": "음성 분석 데이터가 부족합니다."})

    baseline_db = _num(data, "baseline_db")  # None 이면 평가기가 mean_db 로 처리
    word_count = _num(data, "word_count", 0.0) or 0.0
    word_count = max(0, int(word_count))
    stt_confidence = _num(data, "stt_confidence")
    if stt_confidence is not None:
        stt_confidence = min(1.0, max(0.0, stt_confidence))

    evaluator = VoiceEvaluator()
    result = evaluator.evaluate_metrics(
        duration_sec=duration_sec,
        word_count=word_count,
        mean_db=mean_db,
        std_db=std_db if std_db is not None else 0.0,
        silence_segments_2s=int(silence_segments or 0),
        baseline_db=baseline_db,
        stt_confidence=stt_confidence,
    )

    return jsonify({
        "ok": True,
        "score": round(result.total_score),
        "feedback": result.feedback,
        "sub_scores": result.scores,
        "metrics": result.metrics,
    })
