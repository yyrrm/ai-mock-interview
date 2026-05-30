"""
web/server.py — AI 모의면접 웹 백엔드 (Flask)

정적 웹 UI(web/ 폴더)를 서빙하면서, 이력서 PDF 분석과
이력서 기반 질문 생성 API를 함께 제공한다.

실행:
    cd web
    python server.py
    # 브라우저에서 http://localhost:5500 접속
"""
import os
import sys

from flask import Flask, request, jsonify, send_from_directory

# 프로젝트 루트(상위 폴더)를 import 경로에 추가 → modules 패키지 사용
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(WEB_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from modules.question.question_module import analyze_resume, make_question

# PDF 텍스트 추출 (pypdf). 미설치 시 안내 메시지를 위해 예외 처리
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

app = Flask(__name__, static_folder=None)

# 이력서 업로드 용량 제한 (10MB)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024


# ===============================
# 정적 파일 서빙
# ===============================
@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(WEB_DIR, path)


# ===============================
# PDF 텍스트 추출
# ===============================
def extract_pdf_text(file_stream):
    reader = PdfReader(file_stream)
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts).strip()


# ===============================
# API: 이력서 분석
#   multipart/form-data 로 PDF 업로드 → 추출 텍스트 + 요약 + 첫 질문 반환
# ===============================
@app.route("/api/resume", methods=["POST"])
def api_resume():
    if PdfReader is None:
        return jsonify({"ok": False, "msg": "서버에 pypdf가 설치되지 않았습니다. (pip install pypdf)"}), 500

    file = request.files.get("resume")
    if file is None or file.filename == "":
        return jsonify({"ok": False, "msg": "이력서 PDF 파일이 없습니다."}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"ok": False, "msg": "PDF 파일만 업로드할 수 있습니다."}), 400

    topic = (request.form.get("topic") or "면접").strip()

    try:
        text = extract_pdf_text(file.stream)
    except Exception as e:
        return jsonify({"ok": False, "msg": f"PDF를 읽는 중 오류가 발생했습니다: {e}"}), 400

    if not text:
        return jsonify({"ok": False, "msg": "PDF에서 텍스트를 추출하지 못했습니다. (이미지로 된 PDF일 수 있습니다.)"}), 400

    analysis = analyze_resume(text, topic=topic)

    return jsonify(
        {
            "ok": True,
            "resume_text": text,
            "summary": analysis["summary"],
            "first_question": analysis["first_question"],
        }
    )


# ===============================
# API: 다음 질문 생성
#   JSON: { answer_text, topic, previous_questions, resume_context }
# ===============================
@app.route("/api/question", methods=["POST"])
def api_question():
    data = request.get_json(silent=True) or {}
    answer_text = (data.get("answer_text") or "").strip()
    topic = (data.get("topic") or "면접").strip()
    previous_questions = data.get("previous_questions") or []
    resume_context = data.get("resume_context") or ""

    try:
        question = make_question(
            answer_text,
            topic=topic,
            previous_questions=previous_questions,
            resume_context=resume_context,
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
    if PdfReader is None:
        print("  [!] pypdf not installed - resume upload disabled. (pip install pypdf)")
    print("================================================")
    app.run(host="0.0.0.0", port=5500, debug=True)
