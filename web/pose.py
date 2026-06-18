"""
web/pose.py — 실시간 자세 분석 API (브라우저 MediaPipe 좌표 기반)

접근 A: 브라우저가 MediaPipe 로 관절 좌표를 추출해 보내면, 서버는 무거운 영상
처리 없이 좌표만 받아 데스크톱과 동일한 PoseEvaluator 로 점수를 계산한다.

- 프레임을 모아 배치로 받는다(POST). 각 프레임의 실제 시각(t)을 함께 받아
  PoseEvaluator 에 주입 → 흔들림/제스처 타이밍이 정확.
- 좌표 안정화(최근 5프레임 이동평균)는 데스크톱 PoseAnalyzer 와 동일하게 적용.
- PoseEvaluator 는 상태 누적형이므로 면접 세션마다 인스턴스를 하나씩 둔다.
"""
import threading
from collections import deque

import numpy as np
from flask import Blueprint, request, jsonify

from modules.evaluation.pose_evaluator import PoseEvaluator

pose_bp = Blueprint("pose", __name__)

SMOOTH_WINDOW = 5          # 좌표 이동평균 창 (데스크톱과 동일)
MAX_FRAMES_PER_BATCH = 60  # 한 배치 처리 상한 (악의적 대량 입력 방지)

_sessions = {}
_sessions_lock = threading.Lock()


class PoseSession:
    """한 면접 세션의 자세 분석 상태."""

    def __init__(self):
        self.evaluator = PoseEvaluator()
        self.buffer = deque(maxlen=SMOOTH_WINDOW)
        self.scores = []
        self.last_feedback = ""
        self.detected = 0
        self.missed = 0


def _get_session(session_id):
    with _sessions_lock:
        sess = _sessions.get(session_id)
        if sess is None:
            sess = PoseSession()
            _sessions[session_id] = sess
        return sess


def _drop_session(session_id):
    with _sessions_lock:
        _sessions.pop(session_id, None)


def _coords_from_landmarks(landmarks):
    """[[x,y,z(,vis)], ...] → (N,3) numpy. 형식이 이상하면 None."""
    if not isinstance(landmarks, list) or len(landmarks) < 25:
        return None
    try:
        arr = np.asarray(landmarks, dtype=float)
    except (ValueError, TypeError):
        return None
    if arr.ndim != 2 or arr.shape[0] < 25 or arr.shape[1] < 2:
        return None
    return arr[:, :3] if arr.shape[1] >= 3 else np.pad(arr[:, :2], ((0, 0), (0, 1)))


@pose_bp.post("/api/analyze/pose")
def analyze_pose():
    """프레임 배치를 받아 순서대로 평가하고, 마지막 프레임 기준 점수를 반환한다.

    JSON: { session_id, frames: [ { t(ms, 선택), landmarks: [[x,y,z], ... 33] }, ... ] }
    """
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    frames = data.get("frames")
    if not session_id or not isinstance(frames, list):
        return jsonify({"ok": False, "msg": "session_id와 frames가 필요합니다."}), 400

    sess = _get_session(session_id)
    last = None

    for fr in frames[:MAX_FRAMES_PER_BATCH]:
        if not isinstance(fr, dict):
            continue
        coords = _coords_from_landmarks(fr.get("landmarks"))
        if coords is None:
            sess.missed += 1
            continue

        sess.detected += 1
        sess.buffer.append(coords)
        stabilized = np.mean(sess.buffer, axis=0)  # 이동평균 안정화

        t = fr.get("t")
        now = (float(t) / 1000.0) if isinstance(t, (int, float)) else None
        result = sess.evaluator.update(stabilized, now=now)
        if result is not None:
            sess.scores.append(result.total_score)
            sess.last_feedback = result.feedback
            last = result

    if last is None:
        return jsonify({"ok": True, "detected": False})

    return jsonify({
        "ok": True,
        "detected": True,
        "score": round(last.total_score),
        "sub_scores": last.scores,
        "metrics": last.metrics,
        "feedback": last.feedback,
    })


@pose_bp.post("/api/analyze/pose/end")
def analyze_pose_end():
    """세션 동안 누적한 점수의 평균 + 최종 피드백을 반환하고 세션을 정리한다."""
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")

    with _sessions_lock:
        sess = _sessions.get(session_id)

    if sess is None or not sess.scores:
        _drop_session(session_id)
        return jsonify({"ok": True, "score": None, "feedback": "자세 분석 데이터가 부족합니다."})

    avg = sum(sess.scores) / len(sess.scores)
    total = sess.detected + sess.missed
    miss_ratio = (sess.missed / total) if total else 0.0
    feedback = sess.last_feedback or "자세 피드백 없음"

    _drop_session(session_id)
    return jsonify({
        "ok": True,
        "score": round(avg),
        "feedback": feedback,
        "miss_ratio": round(miss_ratio, 2),
        "frames": total,
    })
