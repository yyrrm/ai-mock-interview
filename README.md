# AI 모의면접 (AI Mock Interview)

웹캠과 마이크로 지원자를 실시간 분석하여 **자세 · 시선 · 표정 · 손동작 · 음성**을 평가하고,
답변 내용에 따라 **AI가 다음 면접 질문을 자동 생성**하는 AI 모의면접 시스템입니다. (졸업작품)

## 구성

| 폴더 | 설명 |
|---|---|
| `main.py` | 데스크톱 버전 메인 실행부 (대시보드 + 분석 스레드 통합) |
| `modules/` | 분석 모듈 (자세 / 시선 / 표정 / 손 / 음성 / 질문생성) |
| `web/` | 웹 서비스 UI (HTML/CSS/JS) — 회원가입·면접·결과기록 |

## 데스크톱 버전 실행

```bash
Python 3.11 권장
# 1. 가상환경 생성 & 의존성 설치
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

# 2. 환경변수 설정 (.env 파일 생성)
#   OPENAI_API_KEY=sk-...      # 질문 생성용
#   Google Cloud STT 인증 정보 별도 설정

# 3. 실행
python main.py
```

조작: `[c]` 시선 보정 · `[n]` 다음 질문 · `[q]` 종료

## 웹 UI 실행

```bash
cd web
python -m http.server 5500
# 브라우저에서 http://localhost:5500 접속
```

자세한 내용은 [`web/README.md`](web/README.md) 참고.

## 기술 스택

- **분석**: OpenCV, MediaPipe, py-feat, NumPy/SciPy
- **음성**: PyAudio, Google Cloud Speech (STT)
- **질문 생성**: OpenAI API
- **웹 UI**: HTML / CSS / JavaScript (순수)

## 주의

- `.env`, `key.json` 등 **API 키·인증 파일은 절대 커밋하지 마세요** (`.gitignore`에 등록됨)
- `.venv/`(가상환경)는 커밋하지 않습니다 — `requirements.txt`로 재생성하세요
