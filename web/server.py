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
from datetime import timedelta

from flask import Flask, request, jsonify, send_from_directory

# 프로젝트 루트(상위 폴더)를 import 경로에 추가 → modules 패키지 사용
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(WEB_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# 진짜 UI(React) 빌드 결과물 폴더. frontend 에서 `npm run build` 하면 생성된다.
DIST_DIR = os.path.join(ROOT_DIR, "frontend", "dist")

# 아래 import 들은 위의 sys.path 설정(루트 추가) 이후에 와야 하므로
# 의도적으로 파일 상단이 아닌 이 위치에 둔다(E402 경고는 noqa 로 무시).
from dotenv import load_dotenv  # noqa: E402

# .env (OPENAI_API_KEY, MYSQL_*, SECRET_KEY 등) 로드
load_dotenv()

from modules.question.question_module import (  # noqa: E402
    analyze_resume,
    make_question,
    build_cover_letter_text,
    COVER_LETTER_SECTIONS,
    COVER_LETTER_GUIDANCE,
)
from models import db, ensure_database, database_url  # noqa: E402
from auth import auth_bp  # noqa: E402
from records import records_bp  # noqa: E402
from pose import pose_bp  # noqa: E402
from face import face_bp  # noqa: E402
from voice import voice_bp  # noqa: E402
from tts import tts_bp  # noqa: E402

app = Flask(__name__, static_folder=None)

# 요청 본문 용량 제한 (1MB) — 자기소개서 텍스트만 받으므로 작게 잡는다
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024

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

# 앱 전용 DB(스키마)가 없으면 생성한 뒤, ORM 초기화 + 테이블 생성
ensure_database()
db.init_app(app)
with app.app_context():
    db.create_all()

app.register_blueprint(auth_bp)
app.register_blueprint(records_bp)
app.register_blueprint(pose_bp)
app.register_blueprint(face_bp)
app.register_blueprint(voice_bp)
app.register_blueprint(tts_bp)


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
#   → 항목별 답변을 합쳐 분석 + 첫 질문 반환 (성장과정 비중은 낮게)
# ===============================
MAX_SECTION_CHARS = 2000

@app.route("/api/cover-letter", methods=["POST"])
def api_cover_letter():
    data = request.get_json(silent=True) or {}
    topic = (data.get("topic") or "면접").strip()
    sections = data.get("sections") or {}

    # 각 항목 길이 제한(2000자) 검증
    for sec in COVER_LETTER_SECTIONS:
        val = (sections.get(sec["key"]) or "").strip()
        if len(val) > MAX_SECTION_CHARS:
            return jsonify({"ok": False, "msg": f"'{sec['label']}' 항목은 {MAX_SECTION_CHARS}자 이내로 작성해 주세요."}), 400

    text = build_cover_letter_text(sections)
    if not text:
        return jsonify({"ok": False, "msg": "자기소개서 내용을 한 항목 이상 작성해 주세요."}), 400

    analysis = analyze_resume(text, topic=topic, guidance=COVER_LETTER_GUIDANCE)

    return jsonify(
        {
            "ok": True,
            "resume_text": text,
            "guidance": COVER_LETTER_GUIDANCE,
            "summary": analysis["summary"],
            "first_question": analysis["first_question"],
        }
    )


# ===============================
# API: 다음 질문 생성
#   JSON: { answer_text, topic, previous_questions, resume_context, guidance }
# ===============================
@app.route("/api/question", methods=["POST"])
def api_question():
    data = request.get_json(silent=True) or {}
    answer_text = (data.get("answer_text") or "").strip()
    topic = (data.get("topic") or "면접").strip()
    previous_questions = data.get("previous_questions") or []
    resume_context = data.get("resume_context") or ""
    guidance = data.get("guidance") or ""

    try:
        question = make_question(
            answer_text,
            topic=topic,
            previous_questions=previous_questions,
            resume_context=resume_context,
            guidance=guidance,
        )
        return jsonify({"ok": True, "question": question})
    except Exception as e:
        return jsonify({"ok": False, "msg": f"질문 생성 중 오류: {e}"}), 500


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
