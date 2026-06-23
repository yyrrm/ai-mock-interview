"""자기소개서 입력 적절성 검사 (룰 기반 1차 필터)

자기소개서 문항에 부정적이거나 장난스러운(무성의한) 텍스트가 들어오는 것을
GPT 분석 호출 *전에* 걸러내기 위한 모듈이다.

설계 의도
---------
- 형태적(form) 장난은 여기(룰)에서 잡는다: 자모 반복(ㅋㅋ/ㄷㄷ), 키보드 난타
  (asdf/ㅁㄴㅇㄹ), 무성의 단답(몰라요/그냥요/없음), 초성 욕설, 극단적 길이 미달 등.
- 의미적(content) 장난("돈 벌려고 대충 다니려고요")은 룰로는 잡히지 않으므로,
  추후 LLM 판정(gpt-4.1-mini)을 이 필터 뒤에 붙이는 것을 전제로 한다.
  → 지금은 룰 필터만 구현하고, LLM 판정은 후속 작업으로 남긴다.

이 필터는 "차단(reject)" 여부와 사용자 안내 문구만 돌려준다. API 비용은 0.
"""

from __future__ import annotations

import re
from typing import Dict


# 항목별 최소 길이(공백/특수문자 제외 한글·영문·숫자 기준).
# 이보다 짧으면 성의 자체가 없는 것으로 본다.
MIN_MEANINGFUL_CHARS = 10

# 초성 욕설/비속어(자주 쓰이는 형태만 1차로). 맥락적 혐오·욕설은 추후
# OpenAI Moderation API 로 보강하는 것을 전제로, 여기서는 명백한 패턴만 잡는다.
_PROFANITY_PATTERNS = [
    r"ㅅㅂ", r"ㅄ", r"ㅂㅅ", r"ㅈㄴ", r"ㄲㅈ", r"ㅗ",
    r"시발", r"씨발", r"개새", r"병신", r"좆", r"새끼", r"꺼져", r"닥쳐",
]

# 무성의 단답(항목 전체가 사실상 이것뿐일 때 차단).
_LOW_EFFORT_PHRASES = {
    "몰라요", "모름", "그냥요", "그냥", "없음", "없어요", "없습니다",
    "네", "예", "아니요", "글쎄요", "패스", "스킵", "딱히", "대충",
}

# 한글 음절(가-힣)
_HANGUL_SYLLABLE = re.compile(r"[가-힣]")
# 한글 자모 단독(ㄱ-ㅎ, ㅏ-ㅣ) — 정상 문장엔 거의 없고 'ㅋㅋ/ㅠㅠ'에서 나온다
_HANGUL_JAMO = re.compile(r"[ㄱ-ㅎㅏ-ㅣ]")
# 의미 있는 글자: 한글 음절 + 영문 + 숫자 (길이 계산용)
_MEANINGFUL_CHAR = re.compile(r"[가-힣A-Za-z0-9]")
# 같은 문자 4회 이상 반복 (aaaa, ㅋㅋㅋㅋ, !!!! 등)
_REPEAT_RUN = re.compile(r"(.)\1{3,}")
# 키보드 난타로 흔한 자모/영문 시퀀스
_KEYSMASH_PATTERNS = [
    re.compile(r"[ㅁㄴㅇㄹㅎㅋㅌㅊㅍ]{4,}"),       # ㅁㄴㅇㄹ 류
    re.compile(r"(?:asdf|qwer|zxcv|hjkl|jkl){1,}", re.I),
]


# ===============================
# 프롬프트 인젝션 패턴
#   자기소개서/답변 입력에 "면접관 AI"를 향한 지시를 심어, 면접 시스템을 범용
#   챗봇처럼 악용(예: "이전 지시 무시하고 ~를 답해라")하는 것을 차단한다.
#   GPT 호출 전에 룰로 1차 차단 → 비용 0, 토큰 0.
# ===============================
_INJECTION_PATTERNS = [
    # 지시 무시/덮어쓰기 류 (한/영)
    re.compile(r"(이전|위의|앞의|모든)\s*(지시|명령|규칙|프롬프트|내용)\s*(은|는|을|를)?\s*(무시|잊)", re.I),
    re.compile(r"ignore\s+(all\s+|the\s+|previous\s+|above\s+|prior\s+)*(instruction|prompt|rule|context)", re.I),
    re.compile(r"disregard\s+(all\s+|the\s+|previous\s+|above\s+)*(instruction|prompt|rule)", re.I),
    re.compile(r"forget\s+(everything|all|previous|the\s+above)", re.I),
    # 역할 변경/탈옥 류 ("너는 이제 ~ 챗봇/봇/assistant 이야")
    re.compile(r"(너는|당신은|넌|you\s+are|you're)\b.{0,20}?(챗봇|chatbot|assistant|어시스턴트|봇|bot)", re.I),
    re.compile(r"(역할|role)\s*(을|를|:)?\s*(바꿔|변경|change|switch|reset)", re.I),
    re.compile(r"(개발자\s*모드|developer\s+mode|jailbreak|탈옥|DAN\s+모드)", re.I),
    re.compile(r"(시스템\s*프롬프트|system\s+prompt)\s*(을|를|:)?\s*(보여|알려|출력|reveal|show|print)", re.I),
    # 면접과 무관한 작업 지시(프록시 남용 신호)
    re.compile(r"(번역|translate|요약해|summari[sz]e|코드\s*(짜|작성|만들)|write\s+(me\s+)?(a\s+)?(code|poem|essay|story))", re.I),
    re.compile(r"(대신|instead)\s*(답해|대답해|말해|answer|respond|say)", re.I),
    # 채팅 포맷 주입 (role 토큰 흉내)
    re.compile(r"(^|\n)\s*(system|assistant|user)\s*[:：]", re.I),
    re.compile(r"<\s*/?\s*(system|im_start|im_end|s)\s*>", re.I),
]


def detect_injection(text: str) -> bool:
    """텍스트에 프롬프트 인젝션/탈옥 시도로 보이는 패턴이 있으면 True.

    면접 답변·자기소개서에는 거의 나오지 않는 '모델을 향한 지시' 패턴만 잡는다.
    오탐을 줄이기 위해 명백한 명령형 패턴 위주로 구성했다.
    """
    raw = (text or "")
    if not raw.strip():
        return False
    for pat in _INJECTION_PATTERNS:
        if pat.search(raw):
            return True
    return False


def _meaningful_len(text: str) -> int:
    """공백·기호를 뺀 '의미 있는 글자' 수."""
    return len(_MEANINGFUL_CHAR.findall(text or ""))


def _jamo_ratio(text: str) -> float:
    """전체 한글 글자 중 단독 자모(ㅋ/ㅠ 등)가 차지하는 비율.

    'ㅋㅋㅋ ㅎㅎ' 처럼 자모만 가득하면 1.0 에 가깝다. 정상 문장은 0 에 가깝다.
    """
    syl = len(_HANGUL_SYLLABLE.findall(text or ""))
    jamo = len(_HANGUL_JAMO.findall(text or ""))
    total = syl + jamo
    if total == 0:
        return 0.0
    return jamo / total


def check_section(label: str, text: str) -> Dict[str, object]:
    """자기소개서 한 항목을 검사한다.

    Args:
        label: 항목 라벨(예: "지원동기") — 안내 문구에 쓴다.
        text:  해당 항목의 사용자 입력.

    Returns:
        dict: {"ok": bool, "reason": str, "msg": str}
              ok=False 이면 차단해야 하며, msg 는 사용자에게 보여줄 안내 문구.
    """
    raw = (text or "").strip()

    # 빈 항목은 여기서 판정하지 않는다(여러 항목 중 일부만 작성해도 되므로,
    # 빈/미작성 여부는 호출부에서 종합 판단한다).
    if not raw:
        return {"ok": True, "reason": "empty", "msg": ""}

    lowered = raw.lower()

    # 0) 프롬프트 인젝션: "면접관 AI"에게 지시를 심어 챗봇처럼 악용하는 시도 차단
    if detect_injection(raw):
        return {
            "ok": False,
            "reason": "injection",
            "msg": f"'{label}' 항목에 면접과 무관한 명령/지시문이 포함되어 있어요. "
                   "자기소개 내용만 작성해 주세요.",
        }

    # 1) 초성 욕설/비속어
    for pat in _PROFANITY_PATTERNS:
        if re.search(pat, raw):
            return {
                "ok": False,
                "reason": "profanity",
                "msg": f"'{label}' 항목에 부적절한 표현이 포함되어 있어요. "
                       "면접에 임하는 자세로 다시 작성해 주세요.",
            }

    # 2) 키보드 난타(asdf, ㅁㄴㅇㄹ 등)
    for pat in _KEYSMASH_PATTERNS:
        if pat.search(lowered):
            return {
                "ok": False,
                "reason": "keysmash",
                "msg": f"'{label}' 항목이 의미 없는 입력으로 보여요. "
                       "면접관에게 보여줄 내용을 진지하게 작성해 주세요.",
            }

    # 3) 자모/의성어 도배 (ㅋㅋㅋ, ㅠㅠ, ㄷㄷ ...)
    if _jamo_ratio(raw) >= 0.4:
        return {
            "ok": False,
            "reason": "jamo_spam",
            "msg": f"'{label}' 항목에 'ㅋㅋ' 같은 표현이 많아요. "
                   "자기소개서 형식에 맞게 다시 작성해 주세요.",
        }

    # 4) 무성의 단답 (항목 전체가 사실상 '몰라요/그냥/없음' 류)
    if lowered.replace(" ", "") in {p.replace(" ", "") for p in _LOW_EFFORT_PHRASES}:
        return {
            "ok": False,
            "reason": "low_effort",
            "msg": f"'{label}' 항목이 너무 짧고 성의가 부족해요. "
                   "구체적으로 작성해 주세요.",
        }

    # 5) 극단적 길이 미달 (의미 있는 글자 기준)
    if _meaningful_len(raw) < MIN_MEANINGFUL_CHARS:
        return {
            "ok": False,
            "reason": "too_short",
            "msg": f"'{label}' 항목이 너무 짧아요. "
                   f"최소 {MIN_MEANINGFUL_CHARS}자 이상, 구체적으로 작성해 주세요.",
        }

    # 6) 같은 문자 과도 반복이 입력의 큰 비중을 차지하는 경우
    #    (정상 문장에도 '!!' 정도는 있으므로, 반복 길이가 전체의 30%를 넘을 때만)
    repeats = "".join(m.group(0) for m in _REPEAT_RUN.finditer(raw))
    if repeats and len(repeats) / max(len(raw), 1) >= 0.3:
        return {
            "ok": False,
            "reason": "char_repeat",
            "msg": f"'{label}' 항목에 같은 문자가 과도하게 반복돼요. "
                   "면접에 맞는 내용으로 다시 작성해 주세요.",
        }

    return {"ok": True, "reason": "pass", "msg": ""}


def check_cover_letter(sections, section_defs) -> Dict[str, object]:
    """자기소개서 전체(여러 항목)를 검사한다.

    작성된(비어있지 않은) 항목 중 하나라도 차단 사유가 있으면 전체를 차단한다.

    Args:
        sections:     {key: text} 형태의 사용자 입력.
        section_defs: COVER_LETTER_SECTIONS 같은 [{"key","label",...}] 정의.

    Returns:
        dict: {"ok": bool, "reason": str, "msg": str}
    """
    for sec in section_defs:
        val = (sections.get(sec["key"]) or "").strip()
        if not val:
            continue
        result = check_section(sec["label"], val)
        if not result["ok"]:
            return result
    return {"ok": True, "reason": "pass", "msg": ""}
