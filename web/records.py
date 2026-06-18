"""
web/records.py — 면접 기록 저장/조회 API

로그인한 사용자의 면접 결과를 MySQL(interview_records 테이블)에 저장하고,
사용자별로 조회한다. 모든 요청은 세션 로그인 상태여야 한다.
"""
from flask import Blueprint, request, jsonify

from models import db, InterviewRecord
from auth import current_user

records_bp = Blueprint("records", __name__)


MAX_SCORE_ITEMS = 20  # 점수 항목 개수 상한 (악의적 대량 입력 방지)


def _validate_payload(data):
    """요청 본문을 검증하고 (overall, cleaned_scores) 를 돌려준다.

    문제가 있으면 (None, 오류메시지) 를 반환한다.
    """
    overall = data.get("overall")
    scores = data.get("scores")

    # overall: 0~100 정수
    if isinstance(overall, bool):
        return None, "점수 형식이 올바르지 않습니다."
    try:
        overall = int(overall)
    except (TypeError, ValueError):
        return None, "점수 형식이 올바르지 않습니다."
    if not (0 <= overall <= 100):
        return None, "종합 점수는 0~100 사이여야 합니다."

    # scores: [{name: str, score: 0~100}] 구조·범위 검증
    if not isinstance(scores, list) or not scores:
        return None, "점수 항목이 올바르지 않습니다."
    if len(scores) > MAX_SCORE_ITEMS:
        return None, "점수 항목이 너무 많습니다."

    cleaned = []
    for item in scores:
        if not isinstance(item, dict):
            return None, "점수 항목 구조가 올바르지 않습니다."
        name = item.get("name")
        sc = item.get("score")
        if not isinstance(name, str) or not name.strip():
            return None, "점수 항목 이름이 올바르지 않습니다."
        if isinstance(sc, bool) or not isinstance(sc, (int, float)) or not (0 <= sc <= 100):
            return None, "각 점수는 0~100 사이여야 합니다."
        cleaned.append({"name": name.strip()[:50], "score": int(sc)})

    return overall, cleaned


@records_bp.post("/api/records")
def create_record():
    user = current_user()
    if user is None:
        return jsonify({"ok": False, "msg": "로그인이 필요합니다."}), 401

    data = request.get_json(silent=True) or {}
    overall, cleaned = _validate_payload(data)
    if overall is None:
        return jsonify({"ok": False, "msg": cleaned}), 400  # cleaned = 오류메시지

    try:
        rec = InterviewRecord(user_id=user.id, overall=overall, scores=cleaned)
        db.session.add(rec)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print("기록 저장 오류:", e)
        return jsonify({"ok": False, "msg": "기록 저장 중 오류가 발생했습니다."}), 500

    return jsonify({"ok": True, "record": rec.to_dict()})


@records_bp.get("/api/records")
def list_records():
    user = current_user()
    if user is None:
        return jsonify({"ok": False, "msg": "로그인이 필요합니다."}), 401

    recs = (
        InterviewRecord.query
        .filter_by(user_id=user.id)
        .order_by(InterviewRecord.created_at.desc(), InterviewRecord.id.desc())
        .all()
    )
    return jsonify({"ok": True, "records": [r.to_dict() for r in recs]})
