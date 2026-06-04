# frontend — AI 모의면접 진짜 UI (React + Vite + Tailwind v4)

원본 Replit 프로토타입을 가져와 Replit 전용 설정을 걷어내고, 백엔드 AI(`web/server.py`)에 연결한 버전입니다.

## 화면 흐름
`home → prep(자기소개서 작성 + 장치 점검) → interview(AI 질문/답변) → result(데모 점수)`

- 자기소개서 4문항(성장과정·지원동기·장단점·입사후포부)을 작성 → `POST /api/cover-letter` 로 분석, 첫 질문 생성
- 답변 메모 입력 후 "다음 질문" → `POST /api/question` 으로 꼬리질문 생성 (총 `TARGET_QUESTIONS`개)
- 성장과정은 질문 비중이 낮게 설정됨 (백엔드 guidance)

## 빌드 / 개발

Node.js는 conda 환경 `aiui` 에 설치되어 있습니다. PowerShell에서 PATH를 잡거나 `conda activate aiui` 후 사용하세요.

```powershell
# PATH 직접 지정 예시
$env:Path = "D:\Miniconda\envs\aiui;D:\Miniconda\envs\aiui\Scripts;" + $env:Path

cd frontend
npm install          # 최초 1회
npm run build        # dist/ 생성 → Flask(web/server.py)가 이 폴더를 서빙
```

개발 중 핫리로드가 필요하면 (Flask는 5500에서 따로 실행):

```powershell
npm run dev          # http://localhost:5173, /api 요청은 5500으로 프록시
```

## 백엔드 실행

```powershell
python web/server.py   # http://localhost:5500  (dist/ 를 서빙 + /api/*)
```

> 진짜 AI 질문을 받으려면 프로젝트 루트 `.env` 에 `OPENAI_API_KEY` 를 설정하세요.
> 키가 없으면 폴백(고정) 질문으로 동작합니다.
