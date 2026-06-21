"""
web/face.py — 실시간 표정·시선 분석 API (브라우저 MediaPipe FaceLandmarker 기반)

자세(pose.py)와 같은 '접근 A' 를 따른다: 브라우저가 FaceLandmarker 로 얼굴
블렌드셰이프(52개 표정 계수)와 머리 yaw(코·얼굴 외곽 랜드마크로 계산)를 추출해
보내면, 서버는 무거운 영상 처리 없이 그 값만 받아 표정/시선 점수를 계산한다.

- 한 면접 세션에 ExpressionEvaluator + GazeEvaluator 를 하나씩 둔다(상태 누적형).
- 프레임을 배치로 받아 순서대로 평가하고, 마지막 프레임 기준 점수를 즉시 돌려준다
  (면접 화면의 실시간 표정/시선 태그용).
- /end 에서 세션 평균 점수와 피드백을 돌려주고 세션을 정리한다.
"""
import threading

from flask import Blueprint, request, jsonify

from modules.evaluation.expression_evaluator import ExpressionEvaluator
from modules.evaluation.gaze_evaluator import GazeEvaluator

face_bp = Blueprint("face", __name__)

MAX_FRAMES_PER_BATCH = 60  # 한 배치 처리 상한 (악의적 대량 입력 방지)
MAX_BLEND_KEYS = 60        # 블렌드셰이프 키 개수 상한 (표준 52개)

_sessions = {}
_sessions_lock = threading.Lock()


class FaceSession:
    """한 면접 세션의 표정·시선 분석 상태."""

    def __init__(self):
        self.expression = ExpressionEvaluator()
        self.gaze = GazeEvaluator()


def _get_session(session_id):
    with _sessions_lock:
        sess = _sessions.get(session_id)
        if sess is None:
            sess = FaceSession()
            _sessions[session_id] = sess
        return sess


def _drop_session(session_id):
    with _sessions_lock:
        _sessions.pop(session_id, None)


def _clean_blend(blend):
    """{name: score} 형태만 통과시키고, 숫자가 아닌 값/과도한 키는 버린다."""
    if not isinstance(blend, dict) or not blend:
        return None
    cleaned = {}
    for k, v in list(blend.items())[:MAX_BLEND_KEYS]:
        if isinstance(k, str) and isinstance(v, (int, float)) and not isinstance(v, bool):
            cleaned[k] = float(v)
    return cleaned or None


@face_bp.post("/api/analyze/face")
def analyze_face():
    """표정·시선 프레임 배치를 받아 평가하고 마지막 프레임 점수를 반환한다.

    JSON: { session_id, frames: [ { t(ms, 선택), blend: {name: score}, yaw(선택) }, ... ] }
    """
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    frames = data.get("frames")
    if not session_id or not isinstance(frames, list):
        return jsonify({"ok": False, "msg": "session_id와 frames가 필요합니다."}), 400

    sess = _get_session(session_id)
    last_expr = None
    last_gaze = None

    for fr in frames[:MAX_FRAMES_PER_BATCH]:
        if not isinstance(fr, dict):
            continue
        blend = _clean_blend(fr.get("blend"))
        if blend is None:
            continue

        t = fr.get("t")
        now = (float(t) / 1000.0) if isinstance(t, (int, float)) and not isinstance(t, bool) else None
        yaw = fr.get("yaw")

        er = sess.expression.update(blend, now=now)
        gr = sess.gaze.update(blend, yaw=yaw, now=now)
        if er is not None:
            last_expr = er
        if gr is not None:
            last_gaze = gr

    if last_expr is None and last_gaze is None:
        return jsonify({"ok": True, "detected": False})

    return jsonify({
        "ok": True,
        "detected": True,
        "expression": round(last_expr.total_score) if last_expr is not None else None,
        "gaze": round(last_gaze.total_score) if last_gaze is not None else None,
    })


@face_bp.post("/api/analyze/face/end")
def analyze_face_end():
    """세션 동안 누적한 표정·시선 평균 점수 + 피드백을 반환하고 세션을 정리한다."""
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")

    with _sessions_lock:
        sess = _sessions.pop(session_id, None)

    if sess is None:
        return jsonify({"ok": True, "expression": None, "gaze": None})

    expr = sess.expression.summary()
    gaze = sess.gaze.summary()

    return jsonify({
        "ok": True,
        "expression": None if expr is None else {
            "score": round(expr.total_score),
            "feedback": expr.feedback,
            "sub_scores": expr.scores,
            "metrics": expr.metrics,
        },
        "gaze": None if gaze is None else {
            "score": round(gaze.total_score),
            "feedback": gaze.feedback,
            "sub_scores": gaze.scores,
            "metrics": gaze.metrics,
        },
    })
