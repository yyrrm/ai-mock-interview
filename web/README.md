# AI 모의면접 - 웹 UI (껍데기)

분석 코드 없이 **화면(UI)만** 먼저 만든 버전입니다.
회원가입 · 로그인 · 면접 진행 화면 · 결과 기록 열람까지 흐름이 동작합니다.
데이터는 브라우저 `localStorage`에 저장되어 **서버 없이도 동작하는 것처럼** 보입니다.

## 폴더 구조
```
web/
├─ index.html        랜딩(소개) 페이지
├─ signup.html       회원가입 (아이디/비밀번호/닉네임)
├─ login.html        로그인
├─ dashboard.html    마이페이지 (통계 + 최근 기록)
├─ interview.html    면접 진행 화면 (카메라/점수 placeholder)
├─ history.html      면접 기록 목록
├─ result.html       면접 결과 상세 (점수/피드백/질문)
├─ css/style.css     공통 스타일
└─ js/
   ├─ common.js      헤더·세션·유틸 (로그인 가드)
   ├─ auth.js        회원가입/로그인 로직   ← 나중에 FastAPI 호출로 교체
   └─ data.js        면접 기록 데이터/가짜결과 ← 나중에 FastAPI 호출로 교체
```

## 실행 방법
가장 간단하게는 `index.html`을 더블클릭해 브라우저로 열면 됩니다.
권장: 폴더에서 아래 명령으로 간단한 로컬 서버를 띄우기

```powershell
# web 폴더 안에서
python -m http.server 5500
# 브라우저에서 http://localhost:5500 접속
```

## 데모 흐름
1. **회원가입** → 아이디/비밀번호/닉네임 입력
2. **로그인**
3. **마이페이지**에서 `새 면접 시작`
4. 면접 화면에서 `면접 종료` → 가짜 결과가 생성·저장됨
5. **면접 기록**에서 지난 결과 다시 열람

> 회원·기록 데이터는 이 브라우저에만 저장됩니다. 지우려면 개발자도구 →
> Application → Local Storage 에서 `ai_interview_*` 키를 삭제하세요.

## 나중에 진짜 서비스로 만들 때 (FastAPI 연결)
이 UI는 그대로 두고 **데이터 부분만** 교체하면 됩니다.

| 지금 (껍데기) | 나중 (실서비스) |
|---|---|
| `auth.js`의 `signup()`/`login()` 이 localStorage 사용 | `fetch("/api/signup")` 등 FastAPI 호출로 교체 |
| `data.js`의 기록 저장/조회 | `fetch("/api/records")` 로 DB 연동 |
| `createMockResult()` 가짜 점수 | 실제 분석 모듈(자세/시선/표정/음성) 점수 |
| 카메라 placeholder | 브라우저 `getUserMedia` + 분석 연결 |

- 비밀번호는 데모라 평문 저장 중 → 실서비스에선 **서버에서 해시(bcrypt 등)** 처리
- 전화번호 본인인증(통신사)은 의도적으로 제외
```
