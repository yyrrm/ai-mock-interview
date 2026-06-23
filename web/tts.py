"""
web/tts.py — OpenAI TTS 음성 합성 API

면접 화면의 AI 면접관이 질문을 '자연스러운' 한국어 음성으로 읽도록, 텍스트를
받아 OpenAI TTS(tts-1)로 mp3 음성을 만들어 돌려준다. 브라우저 기본 음성보다
훨씬 자연스럽고, 이미 설정된 OPENAI_API_KEY 를 그대로 쓴다(추가 키 불필요).

질문 한 개(~50자)당 비용은 100만 자당 ~$15 기준 약 $0.001 수준으로 사실상 미미.
키가 없으면 503 을 주고, 프론트는 브라우저 기본 TTS 로 폴백한다.
"""
from flask import Blueprint, request, jsonify, Response

from modules.question.question_module import client  # 이미 만들어 둔 OpenAI 클라이언트 재사용
from auth import login_required, current_user
from usage import enforce_daily_quota

tts_bp = Blueprint("tts", __name__)

MAX_TTS_CHARS = 500          # 질문은 짧으므로 상한을 작게(비용·악용 방지)
TTS_MODEL = "tts-1"          # 빠르고 저렴. 더 고품질은 "tts-1-hd"
DEFAULT_VOICE = "nova"       # 따뜻한 음색. alloy/echo/fable/onyx/nova/shimmer 중 택1
ALLOWED_VOICES = {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}


@tts_bp.post("/api/tts")
@login_required
def synthesize():
    """JSON: { text, voice? } → audio/mpeg(mp3) 바이너리."""
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"ok": False, "msg": "text 가 필요합니다."}), 400

    if client is None:
        # OPENAI_API_KEY 미설정 → 프론트가 브라우저 TTS 로 폴백한다.
        return jsonify({"ok": False, "msg": "OPENAI_API_KEY 가 설정되지 않았습니다."}), 503

    # 계정별 일일 쿼터: 비용 드는 OpenAI 호출 직전에 카운트(빈 text 400 은 차감 안 함).
    allowed, quota_msg = enforce_daily_quota(current_user().id, "tts")
    if not allowed:
        return jsonify({"ok": False, "msg": quota_msg}), 429

    text = text[:MAX_TTS_CHARS]
    voice = (data.get("voice") or DEFAULT_VOICE)
    if voice not in ALLOWED_VOICES:
        voice = DEFAULT_VOICE

    try:
        resp = client.audio.speech.create(
            model=TTS_MODEL,
            voice=voice,
            input=text,
            response_format="mp3",
        )
        audio_bytes = getattr(resp, "content", None)
        if audio_bytes is None:
            audio_bytes = resp.read()
    except Exception as e:
        print("TTS 오류:", e)
        return jsonify({"ok": False, "msg": f"음성 합성 중 오류: {e}"}), 500

    return Response(
        audio_bytes,
        mimetype="audio/mpeg",
        headers={"Cache-Control": "no-store"},
    )
