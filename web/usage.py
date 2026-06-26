"""
web/usage.py — 계정별 '하루 OpenAI 사용량' 쿼터

OpenAI 비용이 드는 엔드포인트(/api/question, /api/cover-letter, /api/tts)를
가입 후 챗봇처럼 남용해 요금이 폭증하는 것을 '계정 단위'로 막는다.
레이트리미트(IP/분)는 단기 폭주를, 이 쿼터(계정/일)는 하루 누적 총량을 막는다.

사용법:
    from usage import enforce_daily_quota
    allowed, msg = enforce_daily_quota(user_id, "question")
    if not allowed:
        return jsonify({"ok": False, "msg": msg}), 429
"""
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from models import db, DailyUsage

# 계정 1개가 하루(UTC)에 호출할 수 있는 최대 횟수.
# 정상 사용자는 거의 닿지 않고, 자동화된 남용만 걸리는 수준으로 잡는다.
DAILY_LIMITS = {
    "question": 100,      # 다음 질문 생성
    "cover_letter": 20,   # 자기소개서 분석(면접 시작)
    "tts": 200,           # 질문 음성 합성 (질문당 1회 + 다시듣기 여유)
    "evaluate": 30,       # 면접 종료 시 답변 내용 채점(세션당 1회)
}

_LIMIT_MSG = "오늘 사용 한도를 초과했습니다. 내일 다시 시도해 주세요."


def _today():
    """쿼터 집계 기준 날짜(UTC, 'YYYY-MM-DD'). 레이트리미트와 동일하게 UTC 사용."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def enforce_daily_quota(user_id, kind):
    """(user_id, 오늘, kind) 카운터를 1 올리고 한도 초과 여부를 돌려준다.

    카운터 증가와 한도 검사를 한 트랜잭션에서 원자적으로 처리해, 동시 요청이
    들어와도 한도를 넘겨 통과시키지 않는다(레이스 방지). 한도를 넘기면 증가분을
    롤백하고 차단한다.

    Returns:
        (allowed: bool, msg: str)  — allowed=False 면 msg 를 사용자에게 보여준다.
    """
    limit = DAILY_LIMITS.get(kind)
    if limit is None:
        # 정의되지 않은 종류는 제한하지 않는다(설정 실수로 정상 기능을 막지 않도록).
        return True, ""

    day = _today()

    # 행이 없으면 만들고, 있으면 count 를 원자적으로 +1 한다.
    # UPDATE ... count = count + 1 은 DB 레벨 원자 연산이라 동시성에 안전하다.
    updated = (
        DailyUsage.query
        .filter_by(user_id=user_id, day=day, kind=kind)
        .update({DailyUsage.count: DailyUsage.count + 1})
    )
    if not updated:
        # 오늘 첫 호출: 행을 새로 만든다. 동시에 두 요청이 INSERT 하면 유니크
        # 제약에 걸리므로, 충돌 시 롤백 후 UPDATE 경로로 재시도한다.
        db.session.add(DailyUsage(user_id=user_id, day=day, kind=kind, count=1))
        try:
            db.session.commit()
            return True, ""
        except IntegrityError:
            db.session.rollback()
            DailyUsage.query.filter_by(user_id=user_id, day=day, kind=kind).update(
                {DailyUsage.count: DailyUsage.count + 1}
            )

    db.session.commit()

    # 방금 증가시킨 값을 다시 읽어 한도와 비교한다.
    row = DailyUsage.query.filter_by(user_id=user_id, day=day, kind=kind).first()
    if row and row.count > limit:
        # 한도 초과 → 방금 더한 1을 되돌려, 이후 요청도 동일하게 차단한다.
        DailyUsage.query.filter_by(user_id=user_id, day=day, kind=kind).update(
            {DailyUsage.count: DailyUsage.count - 1}
        )
        db.session.commit()
        return False, _LIMIT_MSG

    return True, ""
