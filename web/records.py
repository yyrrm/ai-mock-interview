"""
web/records.py — 면접 기록 저장/조회 API

로그인한 사용자의 면접 결과를 MySQL(interview_records 테이블)에 저장하고,
사용자별로 조회한다. 모든 요청은 세션 로그인 상태여야 한다.
"""
from flask import Blueprint, request, jsonify
from sqlalchemy.exc import IntegrityError

from models import db, InterviewRecord
from auth import current_user

records_bp = Blueprint("records", __name__)


MAX_SCORE_ITEMS = 20  # 점수 항목 개수 상한 (악의적 대량 입력 방지)
MAX_EVAL_ITEMS = 10        # answer_eval 항목 개수 상한
MAX_EVAL_TEXT = 1000       # answer_eval 코멘트/종합 텍스트 길이 상한
MAX_QA_PAIRS = 15          # 저장할 질문-답변 쌍 개수 상한
MAX_QA_TEXT = 4000         # 질문/답변 1개 길이 상한 (DB 비대화·악용 방지)


def _clean_qa(raw):
    """질문-답변 전문 페이로드를 검증·정규화한다.

    구조: [{"question": str, "answer": str}, ...]
    없거나 비면 None(저장 안 함 — 선택 필드). 길이/개수 상한을 적용한다.
    """
    if not isinstance(raw, list) or not raw:
        return None
    pairs = []
    for it in raw[:MAX_QA_PAIRS]:
        if not isinstance(it, dict):
            continue
        q = str(it.get("question", "")).strip()[:MAX_QA_TEXT]
        a = str(it.get("answer", "")).strip()[:MAX_QA_TEXT]
        if q or a:
            pairs.append({"question": q, "answer": a})
    return pairs or None


def _clean_answer_eval(raw):
    """answer_eval 페이로드를 검증·정규화해 저장 가능한 dict 로 만든다.

    구조: {"items":[{"label","grade","comment"}], "overall": str}
    없거나 형식이 틀리면 None 을 돌려준다(저장 안 함 — 선택 필드).
    """
    if not isinstance(raw, dict):
        return None
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw:
        return None
    items = []
    for it in items_raw[:MAX_EVAL_ITEMS]:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label", "")).strip()[:50]
        grade = str(it.get("grade", "")).strip()[:10]
        comment = str(it.get("comment", "")).strip()[:MAX_EVAL_TEXT]
        if label:
            items.append({"label": label, "grade": grade, "comment": comment})
    if not items:
        return None
    overall = str(raw.get("overall", "")).strip()[:MAX_EVAL_TEXT]
    return {"items": items, "overall": overall}


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

    # 답변 내용 평가(선택). 없거나 형식이 틀리면 None 으로 저장(채점 실패/구버전).
    answer_eval = _clean_answer_eval(data.get("answer_eval"))
    # 질문-답변 전문(선택). 기록에서 실제 대화를 다시 볼 수 있게 저장.
    qa = _clean_qa(data.get("qa"))
    # 멱등성 키(면접 세션 ID). 같은 면접을 '기록 저장' 재시도/연타로 여러 번
    # 저장해도 한 건만 남기기 위함. 비어 있으면 멱등성 처리를 하지 않는다.
    client_id = data.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        client_id = None
    else:
        client_id = client_id.strip()[:64]

    # 이미 같은 (user_id, client_id) 기록이 있으면 새로 만들지 않고 그대로 반환한다.
    if client_id is not None:
        existing = InterviewRecord.query.filter_by(
            user_id=user.id, client_id=client_id
        ).first()
        if existing is not None:
            return jsonify({"ok": True, "record": existing.to_dict()})

    try:
        rec = InterviewRecord(
            user_id=user.id, overall=overall, scores=cleaned,
            answer_eval=answer_eval, qa=qa, client_id=client_id,
        )
        db.session.add(rec)
        db.session.commit()
    except IntegrityError:
        # 동시 요청이 같은 client_id 로 먼저 INSERT 한 경우(유니크 위반) →
        # 기존 기록을 찾아 반환한다(중복 생성 방지의 최종 방어선).
        db.session.rollback()
        existing = InterviewRecord.query.filter_by(
            user_id=user.id, client_id=client_id
        ).first()
        if existing is not None:
            return jsonify({"ok": True, "record": existing.to_dict()})
        return jsonify({"ok": False, "msg": "기록 저장 중 오류가 발생했습니다."}), 500
    except Exception as e:
        db.session.rollback()
        print("기록 저장 오류:", e)
        return jsonify({"ok": False, "msg": "기록 저장 중 오류가 발생했습니다."}), 500

    return jsonify({"ok": True, "record": rec.to_dict()})


@records_bp.patch("/api/records/<int:record_id>")
def update_record_eval(record_id):
    """기존 면접 기록에 답변 내용 평가(answer_eval)를 뒤늦게 붙인다.

    채점은 비동기로 도착하므로(면접 종료 직후 기록은 먼저 저장됨), 채점이
    완료되면 본인 소유 기록에 한해 answer_eval 만 갱신한다.
    """
    user = current_user()
    if user is None:
        return jsonify({"ok": False, "msg": "로그인이 필요합니다."}), 401

    rec = InterviewRecord.query.filter_by(id=record_id, user_id=user.id).first()
    if rec is None:
        return jsonify({"ok": False, "msg": "기록을 찾을 수 없습니다."}), 404

    data = request.get_json(silent=True) or {}
    answer_eval = _clean_answer_eval(data.get("answer_eval"))
    if answer_eval is None:
        return jsonify({"ok": False, "msg": "평가 내용이 올바르지 않습니다."}), 400

    try:
        rec.answer_eval = answer_eval
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print("평가 갱신 오류:", e)
        return jsonify({"ok": False, "msg": "평가 저장 중 오류가 발생했습니다."}), 500

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
