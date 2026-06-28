"""
web/server.py — AI 모의면접 웹 백엔드 (Flask)

정적 웹 UI(web/ 폴더)를 서빙하면서, 자기소개서 문항 분석과
이력서 기반 질문 생성 API를 함께 제공한다.

실행:
    cd web
    python server.py
    # 브라우저에서 http://localhost:5500 접속
"""
import os
import sys
import logging
from datetime import timedelta

# 모듈 로거(modules.question 등)의 WARNING/exception 이 stdout/journal 에 보이도록
# 최소 로깅 설정. gunicorn 으로 띄우면 이 출력이 systemd journal 에 기록된다.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

from flask import Flask, request, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# 프로젝트 루트(상위 폴더)를 import 경로에 추가 → modules 패키지 사용
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(WEB_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# 진짜 UI(React) 빌드 결과물 폴더. frontend 에서 `npm run build` 하면 생성된다.
DIST_DIR = os.path.join(ROOT_DIR, "frontend", "dist")

from dotenv import load_dotenv

# .env (OPENAI_API_KEY, MYSQL_*, SECRET_KEY 등) 로드
load_dotenv()

from modules.question.question_module import (
    analyze_resume,
    make_question,
    evaluate_answers,
    build_cover_letter_text,
    COVER_LETTER_SECTIONS,
    COVER_LETTER_GUIDANCE,
    SINCERITY_REJECT_THRESHOLD,
    SINCERITY_WARN_THRESHOLD,
)
from modules.question.content_filter import check_cover_letter, detect_injection
from models import db, ensure_database, ensure_schema_migrations, database_url
from auth import auth_bp, login_required, current_user
from usage import enforce_daily_quota
from records import records_bp
from pose import pose_bp
from face import face_bp
from voice import voice_bp
from tts import tts_bp

app = Flask(__name__, static_folder=None)
# Cloudflare/nginx 리버스 프록시 뒤에 있으므로, 원래 요청이 HTTPS였음을
# X-Forwarded-Proto 헤더로 Flask 에 알려준다(Secure 쿠키가 정상 동작하려면 필수).
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# 요청 본문 용량 제한 (1MB) — 자기소개서 텍스트만 받으므로 작게 잡는다
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024

# ===============================
# 레이트 리미팅 (Flask-Limiter)
#   누구나 호출 가능한 OpenAI API 가 반복 호출되어 요금이 폭증하거나
#   서버가 과부하되는 것을 코드 레벨에서 방어한다.
#   ProxyFix 가 X-Forwarded-For 를 처리하므로 get_remote_address 가
#   Cloudflare/nginx 너머의 '실제 클라이언트 IP' 를 반환한다.
#   (없으면 모든 요청이 프록시 IP 하나로 묶여 전체가 함께 차단되니 주의)
# ===============================
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    # 전역 기본 한도: 명시적으로 지정하지 않은 모든 엔드포인트에 적용.
    default_limits=["300 per hour", "60 per minute"],
    # 운영에서 다중 워커를 쓰면 메모리 저장소는 워커마다 별도 카운트가 되어
    # 한도가 느슨해진다. Redis 가 있으면 RATE_LIMIT_STORAGE_URI 로 교체 권장.
    storage_uri=os.getenv("RATE_LIMIT_STORAGE_URI", "memory://"),
    strategy="fixed-window",
)

# ===============================
# 데이터베이스 / 세션 설정
# ===============================
# 세션 쿠키 서명용 키 (.env 의 SECRET_KEY, 없으면 개발용 기본값)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
# 로그인 세션 만료: 마지막 활동 후 2시간이 지나면 자동 로그아웃된다.
# (요청이 있을 때마다 만료 시각이 갱신되는 '비활동 기준' 타이머)
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=2)
app.config["SQLALCHEMY_DATABASE_URI"] = database_url()
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# 로그인 세션 쿠키 보안 플래그 (HTTPS 환경 기준)
# SECURE 는 .env 의 COOKIE_SECURE 로 제어 — 운영(HTTPS)=1, 로컬개발(HTTP)=0
app.config["SESSION_COOKIE_SECURE"] = os.getenv("COOKIE_SECURE", "1") == "1"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# 앱 전용 DB(스키마)가 없으면 생성한 뒤, ORM 초기화 + 테이블 생성
ensure_database()
db.init_app(app)
with app.app_context():
    db.create_all()
    ensure_schema_migrations()  # 기존 테이블의 신규 컬럼(answer_eval) 보강

app.register_blueprint(auth_bp)
app.register_blueprint(records_bp)
app.register_blueprint(pose_bp)
app.register_blueprint(face_bp)
app.register_blueprint(voice_bp)
app.register_blueprint(tts_bp)

# TTS 는 면접 질문마다 호출되지만 1회당 비용이 작다. 블루프린트 전체에
# 시간당·분당 상한을 걸어 비정상적 대량 호출만 막는다(정상 면접엔 영향 없음).
limiter.limit("120 per hour; 20 per minute")(tts_bp)

# 회원가입 IP 레이트리미트: 봇이 계정을 양산해 @login_required 를 우회하고
# OpenAI 엔드포인트를 남용하는 것을 막는다. 정상 가입은 IP당 시간당 5건이면 충분.
# (auth_bp 는 limiter 생성 전에 등록되므로, view 함수에 직접 한도를 건다.)
limiter.limit("5 per hour; 3 per minute")(
    app.view_functions["auth.signup"]
)

# 실시간 분석(자세·표정/시선·음성) 블루프린트: OpenAI 비용은 들지 않지만,
# 비정상적 대량 호출이 서버 CPU/메모리(세션 누적)를 고갈시키는 부하 공격을 막는다.
# 정상 면접은 프레임을 배치로 보내 분당 호출이 많으므로 분당 한도는 넉넉히 잡되,
# 폭주(무한 루프 호출)만 시간당 한도로 끊는다. (@login_required 와 이중 방어)
for _bp in (pose_bp, face_bp, voice_bp):
    limiter.limit("600 per hour; 60 per minute")(_bp)


# 레이트리미트 초과(429) 시 SPA 가 처리하기 쉽도록 JSON 으로 응답한다.
@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({
        "ok": False,
        "msg": "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
    }), 429


# ===============================
# 정적 파일 서빙 (React 빌드본)
#   frontend/dist 의 index.html + assets 를 서빙하고,
#   존재하지 않는 경로는 SPA 라우팅을 위해 index.html 로 폴백한다.
# ===============================
@app.route("/")
def index():
    return send_from_directory(DIST_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    full = os.path.join(DIST_DIR, path)
    if os.path.isfile(full):
        return send_from_directory(DIST_DIR, path)
    # 빌드본이 없을 때를 대비한 안내
    if not os.path.isdir(DIST_DIR):
        return (
            "<h1>프론트엔드 빌드가 필요합니다</h1>"
            "<p><code>cd frontend &amp;&amp; npm run build</code> 를 먼저 실행하세요.</p>",
            500,
        )
    # SPA 폴백
    return send_from_directory(DIST_DIR, "index.html")


# ===============================
# API: 자기소개서 문항 분석
#   JSON: { topic, sections: {growth, motivation, strength_weakness, aspiration} }
#   → 항목별 답변을 합쳐 분석 + 첫 질문 반환 (첫 질문은 '지원동기' 유형)
# ===============================
MAX_SECTION_CHARS = 2000

@app.route("/api/cover-letter", methods=["POST"])
@login_required
@limiter.limit("10 per hour; 3 per minute")
def api_cover_letter():
    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "면접").strip()
    sections = data.get("sections") or {}

    # 각 항목 길이 제한(2000자) 검증
    for sec in COVER_LETTER_SECTIONS:
        val = (sections.get(sec["key"]) or "").strip()
        if len(val) > MAX_SECTION_CHARS:
            return jsonify({"ok": False, "msg": f"'{sec['label']}' 항목은 {MAX_SECTION_CHARS}자 이내로 작성해 주세요."}), 400

    # 적절성 1차 필터(룰 기반): 부정적/장난스러운(무성의) 입력을 GPT 분석 전에 차단.
    # 욕설·키보드 난타·자모 도배·무성의 단답·극단적 길이 미달 등을 잡는다.
    filtered = check_cover_letter(sections, COVER_LETTER_SECTIONS)
    if not filtered["ok"]:
        return jsonify({"ok": False, "msg": filtered["msg"]}), 400

    text = build_cover_letter_text(sections)
    if not text:
        return jsonify({"ok": False, "msg": "자기소개서 내용을 한 항목 이상 작성해 주세요."}), 400

    # 계정별 일일 쿼터: 실제 OpenAI 호출 직전에만 카운트한다(검증 실패는 차감 안 함).
    allowed, msg = enforce_daily_quota(current_user().id, "cover_letter")
    if not allowed:
        return jsonify({"ok": False, "msg": msg}), 429

    analysis = analyze_resume(text, topic=topic, guidance=COVER_LETTER_GUIDANCE)

    # 의미적 적절성(진정성) 분기 — 룰로 못 잡는 '돈 벌려고 대충' 류를 LLM 점수로 처리.
    sincerity = analysis.get("sincerity", 1.0)
    guidance = COVER_LETTER_GUIDANCE

    # (1) 명백히 불성실/장난 → 차단하고 다시 작성 요청
    if sincerity < SINCERITY_REJECT_THRESHOLD:
        return jsonify({
            "ok": False,
            "msg": "자기소개서가 면접에 진지하게 임하는 내용으로 보이지 않아요. "
                   "지원 동기와 강점을 성의 있게 작성해 주세요.",
        }), 400

    # (2) 다소 성의 부족 → 차단하지 않고 진행하되, 이후 질문 생성 시
    #     면접관이 진정성을 확인하는 압박 질문을 하도록 guidance 를 보강한다.
    if sincerity < SINCERITY_WARN_THRESHOLD:
        guidance = (
            guidance
            + "\n[주의] 지원자의 자기소개서가 다소 형식적이거나 성의가 부족하다. "
              "지원 동기의 진정성과 구체성을 확인하는 압박 질문을 적절히 섞어라."
        )

    return jsonify(
        {
            "ok": True,
            "resume_text": text,
            # 보강된 guidance 를 내려보내, 다음 질문(/api/question)에서도 이어지게 한다.
            "guidance": guidance,
            "summary": analysis["summary"],
            "first_question": analysis["first_question"],
        }
    )


# ===============================
# API: 다음 질문 생성
#   JSON: { answer_text, topic, previous_questions, resume_context, guidance,
#           section, category, tech }
#   우선순위: section > category > tech > (꼬리질문)
#   section:  자기소개서 항목 key(있으면 그 항목 주질문)
#   category: 카테고리 풀 key('experience' 등, 있으면 그 유형 씨앗 질문)
#   tech:     true 면 직무(topic) 기반 기술 질문. 모두 없으면 직전 답변 꼬리질문.
# ===============================
MAX_ANSWER_CHARS = 4000  # 답변 1개 길이 상한 (GPT 토큰 비용·악용 방지)

@app.route("/api/question", methods=["POST"])
@login_required
@limiter.limit("60 per hour; 12 per minute")
def api_question():
    data = request.get_json(silent=True) or {}
    answer_text = (data.get("answer_text") or "").strip()[:MAX_ANSWER_CHARS]
    topic = (data.get("topic") or "면접").strip()
    previous_questions = data.get("previous_questions") or []
    resume_context = data.get("resume_context") or ""
    guidance = data.get("guidance") or ""
    # 자기소개서 항목 key('motivation' 등). 있으면 그 항목 기반 '주질문'을 만든다.
    section = (data.get("section") or "").strip() or None
    # 카테고리 풀 key('experience' 등). 있으면 그 유형 씨앗 질문(section 다음 우선).
    category = (data.get("category") or "").strip() or None
    # True 면 직무(topic) 기반 기술 질문을 만든다(section/category 보다 우선순위 낮음).
    # section/category/tech 모두 없으면 직전 답변을 파고드는 '꼬리질문'.
    tech = bool(data.get("tech"))

    # 프롬프트 인젝션 차단: 답변에 "면접관 AI"를 향한 지시("이전 지시 무시…", 번역/코드
    # 요청 등)를 심어 면접 시스템을 범용 챗봇처럼 악용하는 시도를 GPT 호출 전에 막는다.
    if detect_injection(answer_text):
        return jsonify({
            "ok": False,
            "msg": "답변에 면접과 무관한 명령/지시문이 포함되어 있어요. 면접 답변만 입력해 주세요.",
        }), 400

    # 계정별 일일 쿼터: /api/question 은 사실상 GPT 프록시가 될 수 있어 가장 남용되기 쉽다.
    allowed, msg = enforce_daily_quota(current_user().id, "question")
    if not allowed:
        return jsonify({"ok": False, "msg": msg}), 429

    try:
        import time as _t
        _t0 = _t.time()
        question = make_question(
            answer_text,
            topic=topic,
            previous_questions=previous_questions,
            resume_context=resume_context,
            guidance=guidance,
            section=section,
            category=category,
            tech=tech,
        )
        # 실제 질문 생성 소요시간을 journal 에 남긴다(병목 진단용).
        logging.info("TIMING /api/question %.2fs (mode=%s)", _t.time() - _t0,
                     section or category or ("tech" if tech else "followup"))
        return jsonify({"ok": True, "question": question})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"질문 생성 중 오류: {e}"}), 500


# ===============================
# API: 답변 내용 평가 (면접 종료 시 1회)
#   JSON: { qa: [{question, answer}, ...], topic, resume_context }
#   → 항목별 등급(상/중/하) + 코멘트 + 종합 코멘트
# ===============================
MAX_EVAL_QA_PAIRS = 12  # 채점에 받을 Q&A 최대 개수 (악용·토큰 비용 방지)

@app.route("/api/evaluate", methods=["POST"])
@login_required
@limiter.limit("30 per hour; 6 per minute")
def api_evaluate():
    data = request.get_json(silent=True) or {}
    raw_qa = data.get("qa") or []
    topic = (data.get("topic") or "면접").strip()
    resume_context = data.get("resume_context") or ""

    # 이력서 맥락도 클라이언트가 보내는 값이라 프롬프트 인젝션 검사 대상이다.
    # (답변과 동일한 기준으로, 채점 LLM을 조종하려는 시도를 막는다.)
    if detect_injection(resume_context):
        return jsonify({
            "ok": False,
            "msg": "이력서 내용에 면접과 무관한 명령/지시문이 포함되어 있어요.",
        }), 400

    # 입력 정규화: 길이 상한 적용 + 답변에 프롬프트 인젝션이 있으면 차단.
    qa_pairs = []
    for item in raw_qa[:MAX_EVAL_QA_PAIRS]:
        if not isinstance(item, dict):
            continue
        q = (item.get("question") or "").strip()[:MAX_ANSWER_CHARS]
        a = (item.get("answer") or "").strip()[:MAX_ANSWER_CHARS]
        if detect_injection(a):
            return jsonify({
                "ok": False,
                "msg": "답변에 면접과 무관한 명령/지시문이 포함되어 있어요. 면접 답변만 입력해 주세요.",
            }), 400
        if q or a:
            qa_pairs.append({"question": q, "answer": a})

    if not qa_pairs:
        return jsonify({"ok": False, "msg": "평가할 답변이 없습니다."}), 400

    # 계정별 일일 쿼터: 채점도 클로드 호출이라 남용 방지를 위해 카운트한다.
    allowed, msg = enforce_daily_quota(current_user().id, "evaluate")
    if not allowed:
        return jsonify({"ok": False, "msg": msg}), 429

    try:
        result = evaluate_answers(qa_pairs, topic=topic, resume_context=resume_context)
        return jsonify({"ok": result.get("ok", False), **result})
    except Exception as e:
        # 예외 원문을 그대로 사용자에게 노출하지 않는다(내부 경로·설정 유출 방지).
        # 상세는 서버 로그에만 남긴다.
        app.logger.exception("답변 평가 처리 중 예외")
        return jsonify({"ok": False, "msg": "답변 평가 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."}), 500


if __name__ == "__main__":
    print("================================================")
    print("AI Mock Interview - Web server started")
    print("  -> http://localhost:5500")
    if not os.getenv("OPENAI_API_KEY"):
        print("  [!] OPENAI_API_KEY not set - questions use fallback (default) set.")
    if not os.getenv("SECRET_KEY"):
        print("  [!] SECRET_KEY not set - using insecure dev key. Set SECRET_KEY in .env for production.")
    print("================================================")
    app.run(host="0.0.0.0", port=5500, debug=True)
