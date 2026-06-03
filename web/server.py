"""
web/server.py — AI 모의면접 웹 백엔드 (Flask)

정적 웹 UI(web/ 폴더)를 서빙하면서, 이력서 PDF 분석과
이력서 기반 질문 생성 API를 함께 제공한다.

실행:
    cd web
    python server.py
    # 브라우저에서 http://localhost:5500 접속
"""
import io
import os
import sys

from flask import Flask, request, jsonify, send_from_directory

# 프로젝트 루트(상위 폴더)를 import 경로에 추가 → modules 패키지 사용
WEB_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(WEB_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from modules.question.question_module import (
    analyze_resume,
    make_question,
    ocr_pdf_images,
    build_cover_letter_text,
    COVER_LETTER_SECTIONS,
    COVER_LETTER_GUIDANCE,
)

# PDF 텍스트 추출 (pypdf). 미설치 시 안내 메시지를 위해 예외 처리
try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

# 이미지 PDF를 페이지 이미지로 렌더링하기 위한 PyMuPDF(fitz). 미설치 시 OCR 폴백 비활성화
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

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


# 이미지로 된 PDF를 페이지별 PNG 이미지로 렌더링한다 (OCR 입력용).
# zoom 값이 클수록 해상도가 높아져 인식 정확도가 올라가지만 용량/비용도 커진다.
def render_pdf_to_images(data, max_pages=5, zoom=2.0):
    images = []
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        matrix = fitz.Matrix(zoom, zoom)
        for i in range(min(max_pages, doc.page_count)):
            pix = doc.load_page(i).get_pixmap(matrix=matrix)
            images.append(pix.tobytes("png"))
    finally:
        doc.close()
    return images


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

    # 한 번만 읽어서 메모리에 올린다 (텍스트 추출과 OCR 양쪽에서 재사용하기 위함)
    raw = file.read()

    try:
        text = extract_pdf_text(io.BytesIO(raw))
    except Exception as e:
        return jsonify({"ok": False, "msg": f"PDF를 읽는 중 오류가 발생했습니다: {e}"}), 400

    # 텍스트가 비어 있으면 이미지로 된 PDF로 보고 OCR(비전)로 자동 재시도
    if not text and fitz is not None:
        try:
            images = render_pdf_to_images(raw)
            text = ocr_pdf_images(images)
        except Exception as e:
            return jsonify({"ok": False, "msg": f"이미지 PDF를 인식하는 중 오류가 발생했습니다: {e}"}), 400

    if not text:
        if fitz is None:
            return jsonify({"ok": False, "msg": "이미지로 된 PDF로 보입니다. 서버에 PyMuPDF가 설치되어 있지 않아 인식할 수 없습니다. (pip install PyMuPDF)"}), 400
        return jsonify({"ok": False, "msg": "PDF에서 텍스트를 추출하지 못했습니다. 다시 시도하거나 다른 파일을 사용해 주세요."}), 400

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
    if PdfReader is None:
        print("  [!] pypdf not installed - resume upload disabled. (pip install pypdf)")
    if fitz is None:
        print("  [!] PyMuPDF not installed - image(scanned) PDF OCR disabled. (pip install PyMuPDF)")
    print("================================================")
    app.run(host="0.0.0.0", port=5500, debug=True)
