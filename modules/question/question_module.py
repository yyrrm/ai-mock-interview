from dotenv import load_dotenv
import os
import json
from openai import OpenAI

# .env 파일 로드
load_dotenv()

# OpenAI 클라이언트 생성 (API 키가 없으면 None → 폴백 모드로 동작)
_api_key = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=_api_key) if _api_key else None

# 이력서 텍스트가 너무 길면 프롬프트 비용/한도 초과 → 앞부분만 사용
# (자기소개서 4문항 × 2000자 + 라벨까지 담을 수 있도록 넉넉하게 잡는다)
MAX_RESUME_CHARS = 9000

# 자기소개서 문항 정의. 사용자는 각 항목을 1000~2000자로 작성한다.
# weight="low" 인 항목은 질문 생성 시 비중을 낮춘다(성장과정).
COVER_LETTER_SECTIONS = [
    {"key": "growth", "label": "성장과정", "weight": "low"},
    {"key": "motivation", "label": "지원동기", "weight": "normal"},
    {"key": "strength_weakness", "label": "자신의 장단점", "weight": "normal"},
    {"key": "aspiration", "label": "입사 후 포부", "weight": "normal"},
]

# 자기소개서 기반 질문 생성 시 모델에 주는 비중 가이드
COVER_LETTER_GUIDANCE = (
    "이 지원자는 자기소개서를 [성장과정, 지원동기, 자신의 장단점, 입사 후 포부] "
    "항목으로 작성했다. 질문은 지원동기·자신의 장단점·입사 후 포부와 직무 역량에 "
    "집중하고, 성장과정에 관한 질문은 비중을 낮춰 가끔만(전체 질문 중 일부만) 다뤄라."
)


def build_cover_letter_text(sections):
    """자기소개서 문항 답변({key: text})을 라벨이 붙은 하나의 텍스트로 합친다.

    이렇게 합친 텍스트를 이력서 맥락(resume_context)으로 그대로 활용한다.
    """
    parts = []
    for sec in COVER_LETTER_SECTIONS:
        val = (sections.get(sec["key"]) or "").strip()
        if val:
            parts.append(f"[{sec['label']}]\n{val}")
    return "\n\n".join(parts)

# 이력서가 없거나 API 호출이 불가능할 때 쓰는 기본 질문 풀
_FALLBACK_QUESTIONS = [
    "간단히 자기소개 부탁드립니다.",
    "가장 자신 있는 프로젝트 경험을 말씀해주세요.",
    "그 과정에서 가장 어려웠던 점은 무엇이었나요?",
    "팀원과 의견이 충돌하면 어떻게 해결하시나요?",
    "본인의 강점과 약점을 말씀해주세요.",
    "마지막으로 하고 싶은 말이 있나요?",
]


def _clip_resume(resume_context):
    """이력서 텍스트를 안전한 길이로 자른다."""
    if not resume_context:
        return ""
    text = resume_context.strip()
    if len(text) > MAX_RESUME_CHARS:
        text = text[:MAX_RESUME_CHARS] + "\n...(이하 생략)"
    return text


def _resume_block(resume_context):
    """이력서 맥락을 프롬프트에 넣을 블록으로 만든다."""
    clipped = _clip_resume(resume_context)
    if not clipped:
        return ""
    return f"[지원자 이력서 내용]\n{clipped}\n"


def analyze_resume(resume_context, topic="면접", guidance=""):
    """이력서 텍스트를 분석해 요약과 첫 면접 질문을 생성한다.

    Args:
        resume_context: 이력서에서 추출한 텍스트
        topic: 면접 주제 (예: "백엔드 개발", "신입 공채")
        guidance: 질문 비중 등 추가 지침 (예: 자기소개서 항목별 비중)

    Returns:
        dict: {"summary": str, "first_question": str}
    """
    clipped = _clip_resume(resume_context)

    # API 키가 없거나 이력서 텍스트가 비어 있으면 폴백
    if client is None or not clipped:
        return {
            "summary": "(데모 모드) 이력서를 분석하려면 OPENAI_API_KEY 설정이 필요합니다."
            if not clipped or client is None
            else "이력서를 확인했습니다.",
            "first_question": _FALLBACK_QUESTIONS[0],
        }

    guidance_block = f"\n[추가 지침]\n{guidance}\n" if guidance else ""

    prompt = f"""너는 실제 기업 면접관 AI이다.
아래 지원자의 이력서를 읽고, 면접을 시작하기 위한 분석과 첫 질문을 만든다.

[면접 주제]
{topic}

[지원자 이력서 내용]
{clipped}
{guidance_block}
[해야 할 일]
1. 이력서에서 파악한 핵심(주요 경험/기술/강점)을 2~3문장으로 간결하게 요약
2. 이 지원자에게 가장 먼저 물어볼 면접 질문 1개 생성
   - 이력서의 구체적인 경험/기술을 직접 언급해 맞춤형으로
   - 자기소개처럼 너무 뻔하지 않게, 하지만 첫 질문답게 부담스럽지 않게
   - 한두 문장으로 간결하게

[출력 형식]
반드시 아래 JSON 형식으로만 출력 (다른 텍스트 금지):
{{"summary": "...", "first_question": "..."}}
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4.1-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.6,
            response_format={"type": "json_object"},
        )
        data = json.loads(response.choices[0].message.content)
        return {
            "summary": data.get("summary", "이력서를 확인했습니다."),
            "first_question": data.get("first_question", _FALLBACK_QUESTIONS[0]),
        }
    except Exception as e:
        print("이력서 분석 오류:", e)
        return {
            "summary": "이력서를 확인했습니다. (분석 중 오류가 발생해 기본 질문으로 진행합니다.)",
            "first_question": _FALLBACK_QUESTIONS[0],
        }


def make_question(answer_text, topic="면접", previous_questions=None, resume_context=None, guidance=""):
    """지원자의 직전 답변(과 이력서)을 바탕으로 다음 면접 질문을 생성한다.

    Args:
        answer_text: 지원자의 직전 답변 텍스트
        topic: 면접 주제 (예: "백엔드 개발", "신입 공채")
        previous_questions: 지금까지 이미 물어본 질문 리스트(중복 방지용)
        resume_context: 지원자 이력서에서 추출한 텍스트(있으면 맞춤형 질문에 활용)
        guidance: 질문 비중 등 추가 지침 (예: 자기소개서 항목별 비중)
    """
    # API 키가 없으면 폴백: 이미 한 질문과 겹치지 않는 기본 질문을 하나 고른다
    if client is None:
        asked = set(previous_questions or [])
        for q in _FALLBACK_QUESTIONS:
            if q not in asked:
                return q
        return _FALLBACK_QUESTIONS[-1]

    # 이미 했던 질문 목록을 프롬프트에 포함해 중복을 방지한다
    if previous_questions:
        asked = "\n".join(f"- {q}" for q in previous_questions)
        asked_block = f"[이미 했던 질문 (절대 반복 금지)]\n{asked}\n"
    else:
        asked_block = ""

    resume_block = _resume_block(resume_context)
    guidance_block = f"[추가 지침]\n{guidance}\n\n" if guidance else ""

    prompt = f"""너는 실제 기업 면접에서 사용되는 질문을 생성하는 전문 면접관 AI이다.
목표는 지원자의 역량, 사고력, 기술, 의사소통 능력을 자연스럽게 평가하는 것이다.

[면접 주제]
{topic}

{resume_block}[지원자의 직전 답변]
{answer_text}

{asked_block}{guidance_block}[질문 생성 규칙]
1. 이미 했던 질문과 의미가 겹치는 질문은 금지
2. 지나치게 공격적이거나 부정적인 질문은 피할 것
3. 실제 면접에서 사용 가능한 현실적인 질문일 것
4. 이력서 내용이 있으면, 이력서의 구체적 경험/기술과 직전 답변을 연결해 깊이 있게 파고들 것
5. 아래 카테고리 중 하나를 선택하되, 가능한 다양하게:
   - 프로젝트/경험(구체 사례)
   - 문제 해결/트러블슈팅
   - 팀 협업/갈등 해결
   - 기술 선택 이유/설계 판단
   - 강점/약점과 개선 노력
   - 압박 질문(근거 요구)

[출력 형식]
- 질문만 출력 (부가 설명 금지)
- 한 문장에서 두 문장, 너무 길지 않게
"""

    response = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
    )

    return response.choices[0].message.content.strip()
