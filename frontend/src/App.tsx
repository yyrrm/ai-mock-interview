import { useState, useEffect, useRef, useCallback } from "react";
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer } from "recharts";
import { startPoseAnalyzer, type PoseAnalyzerHandle } from "./poseAnalyzer";
import { startFaceAnalyzer, type FaceAnalyzerHandle } from "./faceAnalyzer";
import { startVoiceAnalyzer, type VoiceAnalyzerHandle } from "./voiceAnalyzer";
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "./legalText";

type Screen = "home" | "prep" | "interview" | "result" | "history";

// API 호출 실패(키 미설정/네트워크 오류) 시 사용하는 폴백 질문
const QUESTIONS = [
  "자기소개를 간단히 해주세요. 본인의 강점과 지원 동기를 중심으로 말씀해 주세요.",
  "본인이 경험한 가장 도전적인 프로젝트는 무엇이었나요? 어떻게 해결하셨나요?",
  "팀원과 갈등이 생겼을 때 어떻게 해결하셨나요? 구체적인 사례를 말씀해 주세요.",
  "5년 후 본인의 모습은 어떻게 그리고 계신가요?",
  "지원하신 직무와 관련하여 본인의 역량을 어필해 주세요.",
];

// 한 번의 면접에서 진행할 질문 개수 (AI가 동적으로 생성).
// 사용자가 면접 준비 화면에서 아래 후보 중 하나를 고른다.
// 최소 7개인 이유: 자기소개서 4문항 주질문 + 직무 기술 질문 1개 = 5개가
// 고정으로 들어가므로, 그 뒤 꼬리질문이 최소 2개는 나오도록 7부터 시작한다.
const QUESTION_COUNT_OPTIONS = [7, 10, 15] as const;
const DEFAULT_QUESTION_COUNT = 7;

// 자기소개서 문항 (백엔드 COVER_LETTER_SECTIONS 와 key 일치)
const COVER_SECTIONS = [
  { key: "growth", label: "성장과정", placeholder: "자라온 환경, 가치관 형성에 영향을 준 경험 등" },
  { key: "motivation", label: "지원동기", placeholder: "이 직무·회사에 지원한 이유" },
  { key: "strength_weakness", label: "자신의 장단점", placeholder: "강점과 약점, 그리고 개선 노력" },
  { key: "aspiration", label: "입사 후 포부", placeholder: "입사 후 이루고 싶은 목표와 성장 계획" },
] as const;

// 면접 앞부분에서 '주질문'으로 한 번씩 모두 커버할 자기소개서 항목 순서.
// 첫 질문(자기소개서 분석으로 생성)을 'growth' 슬롯으로 보고, 나머지 항목은
// nextQuestion 이 순서대로 section 을 지정해 주질문을 만든다.
const SECTION_ORDER = ["growth", "motivation", "strength_weakness", "aspiration"] as const;

// 질문 진행 순서(0-based 인덱스):
//   0~3 : 자기소개서 4항목 주질문 (SECTION_ORDER)
//   4   : 직무 기술 질문 1개 (예: "백엔드 기술에 대해 설명해보세요")
//   5~  : 직전 답변을 파고드는 꼬리질문
const TECH_QUESTION_INDEX = SECTION_ORDER.length; // = 4

type CoverSections = Record<string, string>;

// 직무(지원 포지션) 드롭다운 후보. 목록에 없으면 "기타"를 골라 직접 입력한다.
// 산업군 편향을 줄이기 위해 카테고리(optgroup)별로 다양한 직무를 제공한다.
// 직무는 면접 주제 문자열로만 쓰이므로(백엔드 question_module 의 topic) 자유롭게 늘려도 된다.
const JOB_ROLE_GROUPS = [
  {
    label: "IT/개발",
    roles: [
      "백엔드 개발자",
      "프론트엔드 개발자",
      "풀스택 개발자",
      "모바일 앱 개발자",
      "데이터 분석가",
      "데이터 엔지니어",
      "AI/ML 엔지니어",
      "DevOps/인프라 엔지니어",
      "QA/테스트 엔지니어",
      "보안 엔지니어",
    ],
  },
  {
    label: "기획/디자인",
    roles: [
      "기획/PM",
      "서비스 기획자",
      "UX/UI 디자이너",
      "그래픽/비주얼 디자이너",
      "콘텐츠 에디터",
    ],
  },
  {
    label: "마케팅/영업",
    roles: [
      "마케팅",
      "퍼포먼스 마케터",
      "브랜드 마케터",
      "영업/세일즈",
      "해외영업",
      "MD/상품기획",
      "고객지원/CS",
    ],
  },
  {
    label: "경영/사무",
    roles: [
      "경영지원/총무",
      "인사/HR",
      "재무/회계",
      "법무",
      "전략기획",
    ],
  },
  {
    label: "금융",
    roles: [
      "은행/금융 일반",
      "증권/자산운용",
      "보험",
      "리스크/심사",
    ],
  },
  {
    label: "생산/엔지니어링",
    roles: [
      "생산/제조 관리",
      "품질관리(QC)",
      "기계 설계 엔지니어",
      "전기/전자 엔지니어",
      "화학/공정 엔지니어",
      "건축/토목",
      "물류/SCM",
    ],
  },
  {
    label: "보건/교육/공공",
    roles: [
      "간호사",
      "의료/보건",
      "교사/강사",
      "연구원",
      "공무원/공공기관",
      "사회복지",
    ],
  },
  {
    label: "서비스/미디어",
    roles: [
      "호텔/관광",
      "F&B/외식",
      "방송/미디어",
      "PD/기자",
      "통번역",
    ],
  },
] as const;

// 그룹을 펼친 평면 직무 목록(검증·다른 화면에서 단순 목록이 필요할 때 사용).
const JOB_ROLES = JOB_ROLE_GROUPS.flatMap((g) => g.roles);

const JOB_CUSTOM = "__custom__"; // 드롭다운에서 "기타(직접 입력)"를 나타내는 값

// 직무·경력 선택값을 질문 생성용 면접 주제 문자열로 조립한다.
// 예) "백엔드 개발자 (경력 3년) 면접", "마케팅 (신입) 면접", 미설정 시 "면접".
function buildTopic(role: string, career: "junior" | "senior", years: string): string {
  const job = role.trim();
  if (!job) return "면접";
  let level = "";
  if (career === "junior") level = " (신입)";
  else {
    const y = years.trim();
    level = y ? ` (경력 ${y}년)` : " (경력)";
  }
  return `${job}${level} 면접`;
}

// ── 면접 기록 (MySQL, /api/records 로 저장·조회) ──────────────
type InterviewRecord = {
  id: number;
  date: string; // ISO (서버 created_at)
  overall: number;
  scores: { name: string; score: number }[];
  answer_eval?: AnswerEval | null; // 답변 내용 평가(구버전 기록/채점실패면 null)
};

// 분석 채널 메타 — 이름(막대/기록) · 레이더 라벨 · 막대 색.
// 결과 화면·면접 기록은 아래 4개 채널의 '실제' 세션 평균 점수로 그려진다.
const CHANNELS = [
  { key: "expression", name: "표정 분석", radar: "표정 자신감", color: "#1e3a6e" },
  { key: "gaze", name: "시선 추적", radar: "시선 안정성", color: "#3b82f6" },
  { key: "pose", name: "자세 평가", radar: "자세 안정", color: "#1e40af" },
  { key: "voice", name: "음성 분석", radar: "발화 전달력", color: "#2563eb" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];
type ChannelScores = Record<ChannelKey, number | null>;
type ChannelFeedback = Record<ChannelKey, string>;

// 답변 내용 평가(클로드 채점) 결과. 전달력 점수와 별개로, 답변 '내용'을
// 항목별 등급(상/중상/중하/하)+코멘트로 보여준다. 숫자 점수는 신뢰도가 낮아 쓰지 않는다.
type AnswerEval = {
  items: { label: string; grade: string; comment: string }[];
  overall: string;
};

// 채점 진행 상태. "loading"(도착 대기)·"done"(성공)·"failed"(실패→안내 표시).
// 이 상태가 없으면 실패 시 카드가 영영 로딩 스피너로 남아 버린다.
type AnswerEvalStatus = "loading" | "done" | "failed";

type InterviewResult = {
  overall: number;
  scores: { name: string; score: number; color: string }[];
  radar: { subject: string; A: number }[];
  feedback: { type: "good" | "improve"; text: string }[];
  // 답변 내용 평가(클로드). status 로 로딩/성공/실패를 구분한다.
  answerEval?: AnswerEval;
  answerEvalStatus?: AnswerEvalStatus;
  // 평가 무효 사유(예: 3분 미만). 있으면 점수를 매기지 않고 저장도 하지 않는다.
  invalidReason?: string;
};

// 실제 분석 채널 점수/피드백으로 결과 리포트 데이터를 만든다.
// 측정되지 않은 채널(점수 null)은 제외하고, 종합점수는 측정된 것들의 평균.
// 무응답(음성 미감지) 시 종합점수 상한 — 표정/시선/자세가 높아도 이 값을 넘지 못한다.
const NO_SPEECH_OVERALL_CAP = 30;
const MIN_INTERVIEW_SEC = 3 * 60; // 3분 — 이보다 짧으면 점수를 매기지 않고 저장도 하지 않는다

function buildResult(
  scores: ChannelScores,
  fb: ChannelFeedback,
  flags: { noSpeech?: boolean } = {},
): InterviewResult {
  const items = CHANNELS.map((c) => ({ ...c, score: scores[c.key], feedback: fb[c.key] })).filter(
    (c): c is typeof c & { score: number } => c.score != null
  );
  let overall = items.length
    ? Math.round(items.reduce((a, c) => a + c.score, 0) / items.length)
    : 0;

  const feedback = items
    .filter((c) => c.feedback)
    .map((c) => ({
      type: c.score >= 80 ? ("good" as const) : ("improve" as const),
      text: `[${c.name}] ${c.feedback}`,
    }));

  // 실제 답변이 없었다면(무응답) 종합점수를 상한으로 누르고 안내 문구를 맨 앞에 넣는다.
  if (flags.noSpeech) {
    overall = Math.min(overall, NO_SPEECH_OVERALL_CAP);
    feedback.unshift({
      type: "improve" as const,
      text: "[종합] 답변 음성이 거의 감지되지 않았습니다. 질문에 실제로 소리 내어 답변해야 정상적으로 평가됩니다.",
    });
  }

  return {
    overall,
    scores: items.map((c) => ({ name: c.name, score: c.score, color: c.color })),
    radar: items.map((c) => ({ subject: c.radar, A: c.score })),
    feedback,
  };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [animating, setAnimating] = useState(false);
  const [currentQ, setCurrentQ] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [timer, setTimer] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [abandoned, setAbandoned] = useState(false);

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userName, setUserName] = useState("");
  const [authModal, setAuthModal] = useState<{ mode: "login" | "signup"; onSuccess?: () => void } | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // AI 면접 상태
  const [questions, setQuestions] = useState<string[]>([]); // 누적된 질문들
  const [asked, setAsked] = useState<string[]>([]);          // 중복 방지용
  const [resumeText, setResumeText] = useState("");          // 자기소개서 합본 텍스트
  const [guidance, setGuidance] = useState("");              // 질문 비중 지침
  const [topic, setTopic] = useState("면접");                // 면접 주제(직무·경력 조립값) — 첫 질문·꼬리 질문 생성에 사용
  const [targetQuestions, setTargetQuestions] = useState(DEFAULT_QUESTION_COUNT); // 이번 면접 질문 개수(사용자 선택)
  const [busy, setBusy] = useState(false);                   // API 호출 중
  const [poseScore, setPoseScore] = useState<number | null>(null); // 실시간 자세 점수
  const [exprScore, setExprScore] = useState<number | null>(null); // 실시간 표정 점수
  const [gazeScore, setGazeScore] = useState<number | null>(null); // 실시간 시선 점수
  const [result, setResult] = useState<InterviewResult | null>(null); // 최종 결과 리포트

  // 분석기(브라우저 MediaPipe / Web Audio) 핸들 / 세션 ID
  const poseRef = useRef<PoseAnalyzerHandle | null>(null);
  const faceRef = useRef<FaceAnalyzerHandle | null>(null);
  const voiceRef = useRef<VoiceAnalyzerHandle | null>(null);
  const answersRef = useRef<string[]>([]); // STT로 인식된 답변 누적(음성 단어수 폴백 + 마지막 답변 반영용)
  // 질문 인덱스 → 그 질문에 대한 답변. 답변 채점 시 질문↔답변을 '인덱스로' 정확히
  // 매칭하기 위함. answersRef 는 무응답을 건너뛰어 push 하므로 인덱스가 밀린다 →
  // 채점에는 이 맵을 쓴다(무응답 질문은 빈 답으로 남아 정렬이 어긋나지 않는다).
  const qaRef = useRef<Record<number, string>>({});
  const sessionIdRef = useRef<string>("");
  // 비동기 채점이 컴포넌트 언마운트 후 setState 하는 것을 막는 가드.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 앱 로드 시 세션 복원 — 새로고침해도 로그인 유지
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.ok && data.user) {
          setIsLoggedIn(true);
          setUserName(data.user.name);
        }
      })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 네트워크 오류여도 클라이언트 상태는 비운다
    }
    setIsLoggedIn(false);
    setUserName("");
  };

  // 탈퇴 성공(비밀번호 확인 통과) 후 처리 — 실제 API 호출은 DeleteAccountModal 이 담당
  const handleAccountDeleted = () => {
    setDeleteModalOpen(false);
    setIsLoggedIn(false);
    setUserName("");
    navigate("home");
    alert("탈퇴가 완료되었습니다. 그동안 이용해 주셔서 감사합니다.");
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const prepVideoRef = useRef<HTMLVideoElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interviewStartRef = useRef<number>(0); // 면접 시작 시각(ms) — 종료 시 실제 진행 시간 계산용
  const streamRef = useRef<MediaStream | null>(null);

  const navigate = useCallback(
    (to: Screen) => {
      if (animating) return;
      // 브라우저 뒤로/앞으로 가기가 동작하도록 화면 전환을 history 에 기록한다.
      if (to !== screen) window.history.pushState({ screen: to }, "");
      setAnimating(true);
      setTimeout(() => {
        setScreen(to);
        setAnimating(false);
      }, 300);
    },
    [animating, screen]
  );

  // 브라우저 뒤로/앞으로 가기 → 해당 화면으로 복원 (history 에 push 하지 않음)
  useEffect(() => {
    window.history.replaceState({ screen: "home" }, "");
    const onPop = (e: PopStateEvent) => {
      const to: Screen = (e.state && e.state.screen) || "home";
      setAnimating(false);
      setScreen(to);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const startCamera = useCallback(async (ref: React.RefObject<HTMLVideoElement | null>) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (ref.current) {
        ref.current.srcObject = stream;
        ref.current.play();
      }
    } catch {
      console.warn("카메라 접근 권한이 없습니다.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (screen === "prep") {
      startCamera(prepVideoRef);
    } else if (screen === "interview") {
      interviewStartRef.current = Date.now();
      timerRef.current = setInterval(() => setTimer((t) => t + 1), 1000);
      setPoseScore(null);
      setExprScore(null);
      setGazeScore(null);
      // 카메라(영상+오디오) 준비 후 자세·표정·시선·음성 분석을 동시에 시작한다.
      // (음성 분석은 getUserMedia 스트림이 필요하므로 카메라 준비를 await 한다.)
      (async () => {
        await startCamera(videoRef);
        if (cancelled) return;
        const sid = sessionIdRef.current;
        if (videoRef.current && sid) {
          // 자세: 브라우저 PoseLandmarker → 서버 PoseEvaluator
          startPoseAnalyzer(videoRef.current, sid, (s) => setPoseScore(s))
            .then((h) => {
              if (cancelled) h.stop();
              else poseRef.current = h;
            })
            .catch((e) => console.warn("자세 분석 시작 실패:", e));
          // 표정·시선: 브라우저 FaceLandmarker → 서버 Expression/GazeEvaluator
          startFaceAnalyzer(videoRef.current, sid, ({ expression, gaze }) => {
            if (expression != null) setExprScore(expression);
            if (gaze != null) setGazeScore(gaze);
          })
            .then((h) => {
              if (cancelled) h.stop();
              else faceRef.current = h;
            })
            .catch((e) => console.warn("표정/시선 분석 시작 실패:", e));
        }
        // 음성: 브라우저 Web Audio/Web Speech → 서버 VoiceEvaluator
        if (streamRef.current) {
          try {
            voiceRef.current = startVoiceAnalyzer(streamRef.current);
          } catch (e) {
            console.warn("음성 분석 시작 실패:", e);
          }
        }
      })();
    } else {
      stopCamera();
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      // 면접을 정상 종료하면 endInterview 에서 stop(평균 회수) 후 null 로 비운다.
      // 그 외 경로로 화면이 바뀌면 여기서 안전하게 정리한다.
      if (poseRef.current) {
        poseRef.current.stop();
        poseRef.current = null;
      }
      if (faceRef.current) {
        faceRef.current.stop();
        faceRef.current = null;
      }
      if (voiceRef.current) {
        voiceRef.current.stop();
        voiceRef.current = null;
      }
    };
  }, [screen, startCamera, stopCamera]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // AI 면접관 질문 음성(TTS) 재생 중에는 음성 분석을 일시 정지한다.
  // 스피커로 나온 질문 음성이 마이크에 다시 잡혀(에코) 발화 음량·단어 수에 섞이는 것을 막는다.
  const handleSpeakingChange = useCallback((speaking: boolean) => {
    voiceRef.current?.setPaused(speaking);
  }, []);

  const handleStartClick = () => {
    if (!isLoggedIn) {
      setAuthModal({ mode: "login", onSuccess: () => navigate("prep") });
    } else {
      navigate("prep");
    }
  };

  // 자기소개서를 분석해 첫 질문을 받고 면접을 시작한다.
  // jobTopic: 직무·경력을 조립한 면접 주제 문자열(미설정 시 "면접").
  // count: 이번 면접에서 진행할 질문 개수(사용자 선택).
  const goToInterview = async (sections: CoverSections, jobTopic: string, count: number) => {
    // 자세 분석용 세션 ID 발급 (면접 화면 진입 시 분석기가 사용)
    sessionIdRef.current = "pose_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    setBusy(true);
    setTopic(jobTopic); // 꼬리 질문(nextQuestion)에서도 같은 주제를 쓰도록 저장
    setTargetQuestions(count); // 종료 판정·진행 표시에 사용
    let firstQ = QUESTIONS[0];
    let rt = "";
    let gd = "";
    try {
      const res = await fetch("/api/cover-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: jobTopic, sections }),
      });
      const data = await res.json();
      if (data.ok) {
        firstQ = data.first_question || firstQ;
        rt = data.resume_text || "";
        gd = data.guidance || "";
      }
    } catch {
      // 네트워크/서버 오류 시 정적 폴백 질문으로 진행
    }
    setResumeText(rt);
    setGuidance(gd);
    setQuestions([firstQ]);
    setAsked([firstQ]);
    answersRef.current = []; // 새 면접 시작 → 답변 누적 초기화
    qaRef.current = {}; // 질문↔답변 매핑도 초기화
    setCurrentQ(0);
    setTimer(0);
    setBusy(false);
    stopCamera();
    navigate("interview");
  };

  // 직전 답변을 바탕으로 다음 질문을 생성한다. 목표 개수에 도달하면 면접 종료.
  const nextQuestion = async () => {
    if (busy) return;
    if (questions.length >= targetQuestions) {
      await endInterview(false);
      return;
    }
    setBusy(true);
    // 직전 질문에 대한 음성 답변을 STT 전사에서 가져와 꼬리질문 생성에 사용한다.
    const spokenAnswer = voiceRef.current?.takeTranscript() ?? "";
    if (spokenAnswer.trim()) {
      answersRef.current.push(spokenAnswer.trim());
      // 방금 답한 질문(currentQ)에 답변을 매핑 — 채점 시 질문↔답변 정렬용.
      qaRef.current[currentQ] = spokenAnswer.trim();
    }
    // 다음 질문의 종류를 0-based 인덱스(questions.length)로 결정한다.
    //   인덱스 0~3 : 자기소개서 항목 '주질문'. 인덱스 0(첫 질문)은 goToInterview
    //               에서 이미 SECTION_ORDER[0](성장과정)로 만들었으므로, 여기서는
    //               인덱스 1..3 이 나머지 항목 주질문이 된다.
    //   인덱스 4   : 직무 기술 질문(tech).
    //   인덱스 5~  : 직전 답변을 파고드는 꼬리질문(section/tech 모두 없음).
    const nextIndex = questions.length;
    const section = SECTION_ORDER[nextIndex]; // 4 이상이면 undefined
    const tech = nextIndex === TECH_QUESTION_INDEX;
    let nextQ = QUESTIONS[questions.length % QUESTIONS.length];
    try {
      const res = await fetch("/api/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer_text: spokenAnswer,
          topic,
          previous_questions: asked,
          resume_context: resumeText,
          guidance,
          section: section ?? "", // 주질문이면 항목 key, 아니면 빈 문자열
          tech,                   // true 면 직무 기술 질문
        }),
      });
      const data = await res.json();
      if (data.ok && data.question) nextQ = data.question;
    } catch {
      // 오류 시 폴백 질문 사용
    }
    setQuestions((qs) => [...qs, nextQ]);
    setAsked((a) => [...a, nextQ]);
    setCurrentQ((q) => q + 1);
    setBusy(false);
  };

  const endInterview = async (isAbandoned: boolean) => {
    stopCamera();
    // 실제 진행 시간(초). 3분 미만이면 충실한 면접으로 보지 않아 점수를 매기지 않고 저장도 하지 않는다.
    const elapsedSec = interviewStartRef.current
      ? (Date.now() - interviewStartRef.current) / 1000
      : 0;
    const tooShort = elapsedSec < MIN_INTERVIEW_SEC;
    const lastSpoken = voiceRef.current?.takeTranscript() ?? "";
    if (lastSpoken.trim()) {
      answersRef.current.push(lastSpoken.trim()); // 마지막 답변 반영
      qaRef.current[currentQ] = lastSpoken.trim(); // 마지막 질문에 답변 매핑(채점용)
    }

    // 분석기는 어떤 경우든 정리(리소스 해제). 너무 짧은 면접은 점수를 버린다.
    const pose = poseRef.current
      ? await poseRef.current.stop()
      : { score: null as number | null, feedback: "" };
    poseRef.current = null;
    const face = faceRef.current
      ? await faceRef.current.stop()
      : { expression: null, gaze: null, expressionFeedback: "", gazeFeedback: "" };
    faceRef.current = null;
    const voice = voiceRef.current
      ? await voiceRef.current.stop({ fallbackText: answersRef.current.join(" ") })
      : { score: null as number | null, feedback: "" };
    voiceRef.current = null;

    // 3분 미만: 평가 무효 — 점수/저장 없이 안내만 보여준다.
    if (tooShort) {
      setResult({
        overall: 0,
        scores: [],
        radar: [],
        feedback: [],
        invalidReason:
          "면접 진행 시간이 3분 미만으로 너무 짧습니다. 각 질문에 충분히 답변하며 3분 이상 진행해야 평가됩니다.",
      });
      setAbandoned(isAbandoned);
      window.history.pushState({ screen: "result" }, "");
      setScreen("result");
      return;
    }

    const scores: ChannelScores = {
      expression: face.expression,
      gaze: face.gaze,
      pose: pose.score,
      voice: voice.score,
    };
    const fb: ChannelFeedback = {
      expression: face.expressionFeedback,
      gaze: face.gazeFeedback,
      pose: pose.feedback,
      voice: voice.feedback,
    };
    // 음성이 거의 감지되지 않으면(무응답) 종합점수를 제한한다.
    // 표정·시선·자세는 '카메라 앞에 있었는지'만 보므로, 충실한 답변 없이도 높게 나올 수 있다.
    const built = buildResult(scores, fb, { noSpeech: voice.noSpeech === true });
    // 질문↔답변은 qaRef(질문 인덱스 → 답변)로 매칭한다. answersRef[i] 로 맞추면
    // 무응답 질문이 하나라도 있을 때 그 뒤 답변이 한 칸씩 밀려 엉뚱한 질문에 붙는다.
    const answeredQa = asked
      .map((question, i) => ({ question, answer: (qaRef.current[i] ?? "").trim() }))
      .filter((p) => p.answer); // 무응답 질문은 채점에서 제외
    const willEvaluate = voice.noSpeech !== true && answeredQa.length > 0;

    // 채점을 할 경우, 결과 카드를 '로딩' 상태로 먼저 띄운다(도착/실패하면 갱신).
    setResult(willEvaluate ? { ...built, answerEvalStatus: "loading" } : built);

    // 끝까지 완료 + 측정된 점수가 하나라도 있으면 기록으로 저장한다(로그인 사용자, 서버 DB).
    // 저장 완료를 await 해서 결과/기록 화면 진입 시 누락(경쟁 조건)을 막는다.
    // 생성된 record id 를 받아두면, 비동기 채점이 도착했을 때 그 기록에 붙일 수 있다.
    let recordId: number | null = null;
    if (!isAbandoned && built.scores.length > 0) {
      try {
        const res = await fetch("/api/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            overall: built.overall,
            scores: built.scores.map((s) => ({ name: s.name, score: s.score })),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          recordId = data?.record?.id ?? null;
        } else {
          console.warn("면접 기록 저장 실패:", res.status);
        }
      } catch {
        console.warn("면접 기록 저장 중 네트워크 오류");
      }
    }

    setAbandoned(isAbandoned);
    window.history.pushState({ screen: "result" }, "");
    setScreen("result");

    // 답변 내용 평가(클로드 채점)는 수 초~수십 초 걸릴 수 있어, 화면 전환 후 백그라운드로
    // 진행한다. 성공하면 결과 카드를 채우고 기록(record)에도 붙이고, 실패하면 '실패' 상태로
    // 바꿔 무한 로딩 스피너를 피한다. 언마운트 후 setState 는 mountedRef 로 막는다.
    if (willEvaluate) {
      void (async () => {
        try {
          const res = await fetch("/api/evaluate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ qa: answeredQa, topic, resume_context: resumeText }),
          });
          const data = await res.json();
          if (data.ok && Array.isArray(data.items) && data.items.length > 0) {
            const answerEval = { items: data.items, overall: data.overall ?? "" };
            if (mountedRef.current) {
              setResult((prev) =>
                prev ? { ...prev, answerEval, answerEvalStatus: "done" } : prev
              );
            }
            // 채점 결과를 기록에 붙여 새로고침/기록 화면에서도 보이게 한다.
            if (recordId != null) {
              fetch(`/api/records/${recordId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ answer_eval: answerEval }),
              }).catch(() => {
                /* 기록 갱신 실패는 화면 표시에 영향 없음 */
              });
            }
          } else if (mountedRef.current) {
            setResult((prev) => (prev ? { ...prev, answerEvalStatus: "failed" } : prev));
          }
        } catch {
          if (mountedRef.current) {
            setResult((prev) => (prev ? { ...prev, answerEvalStatus: "failed" } : prev));
          }
        }
      })();
    }
  };

  return (
    <div className="min-h-screen bg-background font-sans overflow-hidden">
      <div
        className={`${
          animating
            ? "opacity-0 -translate-y-2 transition-all duration-300"
            : "opacity-100 translate-y-0 transition-all duration-300"
        }`}
      >
        {screen === "home" && (
          <HomeScreen
            isLoggedIn={isLoggedIn}
            userName={userName}
            onStart={handleStartClick}
            onAuth={(mode) => setAuthModal({ mode })}
            onLogout={handleLogout}
            onDeleteAccount={() => setDeleteModalOpen(true)}
            onHistory={() => navigate("history")}
          />
        )}
        {screen === "prep" && (
          <PrepScreen
            videoRef={prepVideoRef}
            onBack={() => navigate("home")}
            onStart={goToInterview}
          />
        )}
        {screen === "interview" && (
          <InterviewScreen
            videoRef={videoRef}
            question={questions[currentQ] || QUESTIONS[currentQ] || ""}
            questionIndex={currentQ}
            totalQuestions={targetQuestions}
            timer={fmt(timer)}
            feedbackOpen={feedbackOpen}
            onToggleFeedback={() => setFeedbackOpen((f) => !f)}
            busy={busy}
            poseScore={poseScore}
            exprScore={exprScore}
            gazeScore={gazeScore}
            onNext={nextQuestion}
            onEnd={() => endInterview(true)}
            onSpeakingChange={handleSpeakingChange}
          />
        )}
        {screen === "result" && (
          <ResultScreen
            abandoned={abandoned}
            result={result}
            showResults={showResults}
            onShowResults={() => setShowResults(true)}
            onRestart={() => {
              setShowResults(false);
              setAbandoned(false);
              navigate("home");
            }}
          />
        )}
        {screen === "history" && (
          <HistoryScreen userName={userName} onBack={() => navigate("home")} />
        )}
      </div>

      {authModal && (
        <AuthModal
          mode={authModal.mode}
          onClose={() => setAuthModal(null)}
          onSuccess={(name) => {
            setIsLoggedIn(true);
            setUserName(name);
            setAuthModal(null);
            authModal.onSuccess?.();
          }}
        />
      )}

      {deleteModalOpen && (
        <DeleteAccountModal
          onClose={() => setDeleteModalOpen(false)}
          onDeleted={handleAccountDeleted}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── HOME ─────────────────────────── */

/* ───────── 랜딩 애니메이션 유틸 & 쇼케이스 섹션 ───────── */

// 요소가 화면에 들어오면 inView=true (한 번만 트리거)
function useInView<T extends HTMLElement>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

// 0 → to 까지 부드럽게 카운트업 (run 이 true 가 되면 시작)
function CountUp({ to, run, duration = 1100 }: { to: number; run: boolean; duration?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!run) return;
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setN(Math.round(to * eased));
      if (k < 1) raf = requestAnimationFrame(step);
      else setN(to);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [run, to, duration]);
  return <>{n}</>;
}

// 원형 점수 게이지
function ScoreRing({ value, color, label, run }: { value: number; color: string; label: string; run: boolean }) {
  const R = 50;
  const C = 2 * Math.PI * R;
  return (
    <div className="relative w-[120px] h-[120px] text-center">
      <svg width="120" height="120" className="-rotate-90">
        <circle cx="60" cy="60" r={R} stroke="hsl(var(--border))" strokeWidth="10" fill="none" />
        <circle
          cx="60"
          cy="60"
          r={R}
          stroke={color}
          strokeWidth="10"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={run ? C * (1 - value / 100) : C}
          style={{ transition: "stroke-dashoffset 1.3s cubic-bezier(.34,1.2,.64,1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-[hsl(var(--primary))]">
          <CountUp to={value} run={run} />
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

// 히어로 '실시간 분석 중' 패널 — 막대 채워짐 + 숫자 카운트업
const HERO_BARS = [
  { label: "시선 안정성", val: 74, color: "bg-[hsl(213,90%,60%)]" },
  { label: "표정 자신감", val: 82, color: "bg-[hsl(222,47%,35%)]" },
  { label: "자세 균형", val: 88, color: "bg-emerald-500" },
  { label: "발화 명확성", val: 79, color: "bg-violet-500" },
];

function HeroPanel() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  return (
    <div ref={ref} className="navy-card rounded-2xl p-6 shadow-xl relative overflow-hidden text-left">
      <div className="absolute top-0 right-0 w-32 h-32 bg-[hsl(var(--accent))/0.05] rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="flex items-center gap-3 mb-5">
        <div className="w-8 h-8 navy-gradient rounded-lg flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-[hsl(var(--primary))]">실시간 분석 중</p>
          <p className="text-xs text-muted-foreground">4개 채널 동시 분석</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-red-500 font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 recording-dot" />
          REC
        </div>
      </div>

      <div className="space-y-3 mb-5">
        {HERO_BARS.map((item, i) => (
          <div key={item.label}>
            <div className="flex justify-between mb-1">
              <span className="text-xs text-muted-foreground">{item.label}</span>
              <span className="text-xs font-bold text-[hsl(var(--primary))]">
                <CountUp to={item.val} run={inView} />
              </span>
            </div>
            <div className="h-1.5 bg-[hsl(var(--border))] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${item.color}`}
                style={{
                  width: inView ? `${item.val}%` : "0%",
                  transition: `width 1.1s cubic-bezier(.34,1.3,.64,1) ${i * 0.12}s`,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="bg-[hsl(var(--secondary))] rounded-xl p-3.5 border border-[hsl(var(--border))]">
        <p className="text-xs text-muted-foreground mb-1 font-medium">AI 꼬리 질문</p>
        <p className="text-sm text-[hsl(var(--primary))] font-medium leading-snug">
          "방금 말씀하신 프로젝트에서 팀원과의 의사소통은 어떻게 이루어졌나요?"
        </p>
      </div>
    </div>
  );
}

// ── 핵심 엔진 아래: 실시간 분석(링) 쇼케이스 ──
const SHOWCASE_RINGS = [
  { label: "표정", value: 82, color: "#16a34a" },
  { label: "시선", value: 71, color: "#3b82f6" },
  { label: "자세", value: 88, color: "#10b981" },
  { label: "음성", value: 79, color: "#8b5cf6" },
];

function AnalysisShowcase() {
  const [ref, inView] = useInView<HTMLDivElement>(0.35);
  return (
    <div className="bg-white py-16 px-8 border-t border-[hsl(var(--border))]">
      <div className="max-w-4xl mx-auto text-center">
        <p className="text-sm font-bold text-[hsl(var(--accent))] uppercase tracking-widest mb-3">실시간 분석</p>
        <h2 className="text-3xl md:text-4xl font-bold text-[hsl(var(--primary))] mb-3">실시간으로 이렇게 분석됩니다</h2>
        <p className="text-base text-muted-foreground max-w-xl mx-auto leading-relaxed mb-10">
          면접 중 <span className="whitespace-nowrap">표정·시선·자세·음성</span>이 <span className="whitespace-nowrap">0~100점으로</span> 실시간 채점됩니다.
        </p>
        <div ref={ref} className="navy-card rounded-2xl p-8 flex flex-wrap items-center justify-center gap-8">
          {SHOWCASE_RINGS.map((r) => (
            <ScoreRing key={r.label} value={r.value} color={r.color} label={r.label} run={inView} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 핵심 엔진 아래: 결과 리포트 쇼케이스 ──
const SHOWCASE_CHANNELS: { name: string; score: number; color: string; subs: [string, number][] }[] = [
  { name: "표정 분석", score: 82, color: "#1e3a6e", subs: [["미소", 100], ["긴장도", 64]] },
  { name: "시선 추적", score: 71, color: "#3b82f6", subs: [["중심도", 70], ["안정성", 73]] },
  { name: "자세 평가", score: 88, color: "#1e40af", subs: [["기울기", 100], ["흔들림", 70], ["제스처", 92]] },
  { name: "음성 분석", score: 79, color: "#2563eb", subs: [["속도", 100], ["음량", 70], ["침묵", 100], ["명료도", 70]] },
];
const SHOWCASE_OVERALL = Math.round(
  SHOWCASE_CHANNELS.reduce((a, c) => a + c.score, 0) / SHOWCASE_CHANNELS.length
);

function ResultShowcase() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="bg-[hsl(222,47%,97%)] py-16 px-8 border-t border-[hsl(var(--border))]">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-sm font-bold text-[hsl(var(--accent))] uppercase tracking-widest mb-3">결과 리포트</p>
          <h2 className="text-3xl md:text-4xl font-bold text-[hsl(var(--primary))] mb-3">면접이 끝나면 이런 리포트를 받습니다</h2>
          <p className="text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
            <span className="md:whitespace-nowrap">종합 점수와 영역별 점수, 세부 지표,</span>{" "}
            <span className="md:whitespace-nowrap">AI 피드백까지 한눈에 확인하세요.</span>
          </p>
        </div>

        <div ref={ref} className="navy-card rounded-2xl p-8 text-center mb-6">
          <p className="text-muted-foreground text-sm mb-2">종합 점수</p>
          <div className="text-6xl font-bold text-[hsl(var(--primary))] mb-3">
            <CountUp to={SHOWCASE_OVERALL} run={inView} />
          </div>
          <div className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 px-3 py-1.5 rounded-full">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-green-700 text-sm font-semibold">우수한 성과입니다!</span>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          <div className="navy-card rounded-2xl p-6">
            <h3 className="font-bold text-[hsl(var(--primary))] mb-5">
              영역별 점수 <span className="text-xs font-normal text-muted-foreground">(클릭해서 세부지표 보기)</span>
            </h3>
            <div className="flex flex-col gap-4">
              {SHOWCASE_CHANNELS.map((c, i) => (
                <div key={c.name} className="cursor-pointer" onClick={() => setOpen(open === i ? null : i)}>
                  <div className="flex justify-between mb-1.5">
                    <span className="text-sm font-medium text-foreground">{c.name}</span>
                    <span className="text-sm font-bold text-[hsl(var(--primary))]">{c.score}점</span>
                  </div>
                  <div className="h-2.5 bg-[hsl(var(--border))] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: inView ? `${c.score}%` : "0%",
                        backgroundColor: c.color,
                        transition: `width 1s cubic-bezier(.34,1.3,.64,1) ${i * 0.1}s`,
                      }}
                    />
                  </div>
                  <div className="overflow-hidden transition-all duration-300" style={{ maxHeight: open === i ? 160 : 0 }}>
                    <div className="pt-2.5">
                      {c.subs.map((s) => (
                        <div key={s[0]} className="flex justify-between text-xs text-muted-foreground py-1">
                          <span>{s[0]}</span>
                          <b className="text-foreground">{s[1]}점</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="navy-card rounded-2xl p-6">
            <h3 className="font-bold text-[hsl(var(--primary))] mb-4">AI 피드백 요약</h3>
            <div className="flex flex-col gap-3">
              {[
                { type: "good", text: "카메라를 안정적으로 응시했습니다. 좋은 아이컨택입니다." },
                { type: "good", text: "자연스럽고 안정적인 표정을 잘 유지했습니다." },
                { type: "improve", text: "상체 흔들림이 조금 있습니다. 자세를 안정적으로 유지해보세요." },
                { type: "improve", text: "말 속도가 약간 빠릅니다. 130~180 WPM을 목표로 해보세요." },
              ].map((fb, i) => (
                <div
                  key={i}
                  className={`rounded-xl p-3.5 text-sm leading-relaxed ${
                    fb.type === "good"
                      ? "bg-green-50 border border-green-200 text-green-800"
                      : "bg-yellow-50 border border-yellow-200 text-yellow-800"
                  }`}
                >
                  <span className="font-semibold mr-1.5">{fb.type === "good" ? "✓" : "!"}</span>
                  {fb.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeScreen({
  isLoggedIn,
  userName,
  onStart,
  onAuth,
  onLogout,
  onDeleteAccount,
  onHistory,
}: {
  isLoggedIn: boolean;
  userName: string;
  onStart: () => void;
  onAuth: (m: "login" | "signup") => void;
  onLogout: () => void;
  onDeleteAccount: () => void;
  onHistory: () => void;
}) {
  return (
    <div className="min-h-screen flex flex-col screen-enter">
      {/* Navigation */}
      <nav className="navy-gradient px-4 sm:px-8 py-4 flex items-center justify-between gap-3 shadow-lg">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z"/>
              <path d="M20.84 14a8 8 0 0 1-15.68 0"/>
            </svg>
          </div>
          <span className="text-white font-bold text-base tracking-tight truncate">InterviewAI</span>
        </div>

        <div className="hidden md:flex items-center gap-6 text-sm text-white/70">
          {isLoggedIn && (
            <span
              data-testid="link-history"
              onClick={onHistory}
              className="hover:text-white cursor-pointer transition-colors"
            >
              내 면접 기록
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {isLoggedIn ? (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded-lg">
                <div className="w-6 h-6 rounded-full bg-[hsl(var(--accent))] flex items-center justify-center text-white text-xs font-bold">
                  {userName.charAt(0).toUpperCase()}
                </div>
                <span className="text-white/90 text-sm font-medium">{userName}</span>
              </div>
              <button
                data-testid="button-logout"
                onClick={onLogout}
                className="px-2.5 sm:px-4 py-2.5 text-white/70 text-sm sm:text-base font-medium whitespace-nowrap hover:text-white transition-colors"
              >
                로그아웃
              </button>
              <button
                data-testid="button-delete-account"
                onClick={onDeleteAccount}
                className="px-2.5 sm:px-4 py-2.5 text-white/50 text-sm sm:text-base whitespace-nowrap hover:text-red-300 transition-colors"
              >
                회원 탈퇴
              </button>
            </>
          ) : (
            <>
              <button
                data-testid="button-login"
                onClick={() => onAuth("login")}
                className="px-3 sm:px-6 py-2.5 sm:py-3 text-white/90 text-sm sm:text-base font-medium rounded-xl whitespace-nowrap hover:bg-white/10 transition-colors"
              >
                로그인
              </button>
              <button
                data-testid="button-signup"
                onClick={() => onAuth("signup")}
                className="px-4 sm:px-6 py-2.5 sm:py-3 bg-white text-[hsl(var(--primary))] text-sm sm:text-base font-bold rounded-xl whitespace-nowrap hover:bg-white/90 transition-colors shadow-sm"
              >
                시작하기
              </button>
            </>
          )}
        </div>
      </nav>

      {/* Hero */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[hsl(222,47%,97%)] to-white">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] rounded-full bg-[hsl(213,90%,60%)/0.06] blur-3xl -translate-y-1/2 translate-x-1/4 pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-96 h-96 rounded-full bg-[hsl(222,47%,23%)/0.04] blur-3xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />

        <div className="relative max-w-3xl mx-auto px-6 py-20 flex flex-col items-center text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[hsl(var(--accent))/0.1] border border-[hsl(var(--accent))/0.2] rounded-full mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--accent))] recording-dot" />
            <span className="text-xs font-semibold text-[hsl(var(--accent))]">
              AI 멀티모달 면접 분석 플랫폼
            </span>
          </div>

          <h1 className="text-2xl sm:text-3xl md:text-5xl font-bold text-[hsl(var(--primary))] leading-[1.3] tracking-tight mb-5 break-keep">
            <span className="block sm:whitespace-nowrap">막연한 연습은 그만,</span>
            <span className="block sm:whitespace-nowrap">
              구체적인 피드백으로 <span className="text-[hsl(var(--accent))]">합격</span>에 가까워지세요
            </span>
          </h1>

          <p className="text-base md:text-lg text-muted-foreground leading-relaxed mb-9 max-w-2xl">
            <span className="md:whitespace-nowrap">내 자기소개서로 만든 맞춤 질문과 꼬리 질문으로 실전처럼 연습하고,</span>{" "}
            <span className="md:whitespace-nowrap"><span className="whitespace-nowrap">시선·표정·음성·자세</span> 분석 리포트까지 받아보세요.</span>
          </p>

          <button
            data-testid="button-start"
            onClick={onStart}
            className="navy-gradient px-10 py-5 rounded-2xl text-white font-bold text-lg shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 transition-all duration-200 inline-flex items-center gap-2.5"
          >
            면접 시작하기
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          </button>

          <div className="mt-8 flex items-center justify-center gap-6 flex-wrap">
            {[
              { label: "자기소개서 기반 맞춤 질문" },
              { label: "꼬리 질문 자동 생성" },
              { label: "면접 기록 저장" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--accent))" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {item.label}
              </div>
            ))}
          </div>

          {/* 실시간 분석 패널 — '면접 시작하기' 버튼 아래, 가운데 정렬 */}
          <div className="w-full max-w-2xl mt-14">
            <HeroPanel />
          </div>
        </div>
      </div>

      {/* Features grid */}
      <div className="bg-white py-16 px-8 border-t border-[hsl(var(--border))]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-sm font-bold text-[hsl(var(--accent))] uppercase tracking-widest mb-3">핵심 기능</p>
            <h2 className="text-3xl md:text-4xl font-bold text-[hsl(var(--primary))] mb-3">
              합격을 만드는 5가지 핵심 엔진
            </h2>
            <p className="text-base text-muted-foreground max-w-xl mx-auto leading-relaxed">
              <span className="md:whitespace-nowrap"><span className="whitespace-nowrap">시선·표정·음성·자세</span> 실시간 분석부터</span>{" "}
              <span className="md:whitespace-nowrap">자기소개서 맞춤 질문까지, AI가 함께합니다.</span>
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-7 max-w-4xl mx-auto">
            {[
              {
                // 시선 — 두 눈 + 시선이 카메라(타깃)를 향하는 일러스트
                art: (
                  <svg className="absolute inset-0 w-full h-full transition-transform duration-300 group-hover:scale-105" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
                    <defs>
                      <linearGradient id="artGazeBg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#16294d" /><stop offset="1" stopColor="#2a4a86" />
                      </linearGradient>
                    </defs>
                    <rect width="400" height="200" fill="url(#artGazeBg)" />
                    <g stroke="#ffffff" strokeOpacity="0.06"><path d="M0 50H400M0 100H400M0 150H400M100 0V200M200 0V200M300 0V200" /></g>
                    <g transform="translate(140 112)">
                      <path d="M-40 0Q0 -28 40 0Q0 28 -40 0Z" fill="#ffffff" fillOpacity="0.12" stroke="#9ec5ff" strokeWidth="2.5" />
                      <circle r="14" fill="#3b82f6" /><circle r="6.5" fill="#0b1f3f" /><circle cx="5" cy="-4" r="3" fill="#ffffff" />
                    </g>
                    <g transform="translate(260 112)">
                      <path d="M-40 0Q0 -28 40 0Q0 28 -40 0Z" fill="#ffffff" fillOpacity="0.12" stroke="#9ec5ff" strokeWidth="2.5" />
                      <circle r="14" fill="#3b82f6" /><circle r="6.5" fill="#0b1f3f" /><circle cx="5" cy="-4" r="3" fill="#ffffff" />
                    </g>
                    <g stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="5 5" strokeOpacity="0.8"><line x1="140" y1="112" x2="200" y2="48" /><line x1="260" y1="112" x2="200" y2="48" /></g>
                    <g transform="translate(200 48)" stroke="#60a5fa" strokeWidth="2" fill="none">
                      <circle r="13" strokeOpacity="0.9" /><line x1="-20" x2="-15" /><line x1="15" x2="20" /><line y1="-20" y2="-15" /><line y1="15" y2="20" />
                      <circle r="3" fill="#60a5fa" stroke="none" />
                    </g>
                  </svg>
                ),
                title: "시선 분석",
                desc: "시선이 카메라를 안정적으로 향하는지, 한쪽으로 쏠리거나 흔들리지는 않는지 실시간으로 분석해 아이컨택을 평가합니다.",
              },
              {
                // 표정 — 미소 짓는 얼굴 + 표정 포인트 일러스트
                art: (
                  <svg className="absolute inset-0 w-full h-full transition-transform duration-300 group-hover:scale-105" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
                    <defs>
                      <linearGradient id="artExprBg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#15294d" /><stop offset="1" stopColor="#2b4f93" />
                      </linearGradient>
                    </defs>
                    <rect width="400" height="200" fill="url(#artExprBg)" />
                    <g stroke="#ffffff" strokeOpacity="0.06"><path d="M0 50H400M0 100H400M0 150H400M100 0V200M200 0V200M300 0V200" /></g>
                    <g transform="translate(200 100)">
                      <circle r="62" fill="#ffffff" fillOpacity="0.08" stroke="#9ec5ff" strokeOpacity="0.6" strokeWidth="2" />
                      <path d="M-36 -22q12 -8 26 -2" fill="none" stroke="#9ec5ff" strokeWidth="3" strokeLinecap="round" />
                      <path d="M10 -24q14 -6 26 2" fill="none" stroke="#9ec5ff" strokeWidth="3" strokeLinecap="round" />
                      <circle cx="-22" cy="-6" r="5" fill="#3b82f6" /><circle cx="22" cy="-6" r="5" fill="#3b82f6" />
                      <circle cx="-40" cy="16" r="7" fill="#f9a8d4" fillOpacity="0.5" /><circle cx="40" cy="16" r="7" fill="#f9a8d4" fillOpacity="0.5" />
                      <path d="M-28 22Q0 48 28 22" fill="none" stroke="#60a5fa" strokeWidth="4" strokeLinecap="round" />
                      <g fill="#60a5fa"><circle cx="-28" cy="22" r="2.5" /><circle cx="0" cy="36" r="2.5" /><circle cx="28" cy="22" r="2.5" /></g>
                    </g>
                    <path d="M330 48l4 11l11 4l-11 4l-4 11l-4 -11l-11 -4l11 -4z" fill="#fcd34d" />
                  </svg>
                ),
                title: "표정 분석",
                desc: "미소와 표정 변화를 분석해 너무 굳어 있거나 긴장한 인상은 아닌지 확인하고, 자연스럽고 자신감 있는 표정을 코칭합니다.",
              },
              {
                // 음성 — 마이크 + 음파 + 파형 일러스트
                art: (
                  <svg className="absolute inset-0 w-full h-full transition-transform duration-300 group-hover:scale-105" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
                    <defs>
                      <linearGradient id="artVoiceBg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#15294d" /><stop offset="1" stopColor="#1d63b0" />
                      </linearGradient>
                    </defs>
                    <rect width="400" height="200" fill="url(#artVoiceBg)" />
                    <g fill="none" stroke="#9ec5ff" strokeOpacity="0.22" strokeWidth="2"><circle cx="200" cy="86" r="46" /><circle cx="200" cy="86" r="70" /><circle cx="200" cy="86" r="94" /></g>
                    <g transform="translate(200 86)">
                      <rect x="-16" y="-40" width="32" height="56" rx="16" fill="#ffffff" fillOpacity="0.92" />
                      <path d="M-26 2a26 26 0 0 0 52 0" fill="none" stroke="#9ec5ff" strokeWidth="4" strokeLinecap="round" />
                      <line x1="0" y1="28" x2="0" y2="40" stroke="#9ec5ff" strokeWidth="4" strokeLinecap="round" /><line x1="-12" y1="40" x2="12" y2="40" stroke="#9ec5ff" strokeWidth="4" strokeLinecap="round" />
                    </g>
                    <g fill="#60a5fa">
                      {Array.from({ length: 27 }).map((_, i) => {
                        const h = 8 + Math.abs(Math.sin(i * 0.8) * 28);
                        return <rect key={i} x={16 + i * 13.7} y={172 - h / 2} width="6" height={h} rx="3" fillOpacity={0.85} />;
                      })}
                    </g>
                  </svg>
                ),
                title: "음성 분석",
                desc: "말하는 속도와 목소리 크기, 말 사이의 멈춤을 분석해 또렷하고 안정적인 전달력을 평가합니다.",
              },
              {
                // 자세 — 포즈 스켈레톤 관절 일러스트
                art: (
                  <svg className="absolute inset-0 w-full h-full transition-transform duration-300 group-hover:scale-105" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
                    <defs>
                      <linearGradient id="artPoseBg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#16294d" /><stop offset="1" stopColor="#234a86" />
                      </linearGradient>
                    </defs>
                    <rect width="400" height="200" fill="url(#artPoseBg)" />
                    <g stroke="#ffffff" strokeOpacity="0.06"><path d="M0 40H400M0 80H400M0 120H400M0 160H400M80 0V200M160 0V200M240 0V200M320 0V200" /></g>
                    <g transform="translate(200 20)" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" fill="none">
                      <line x1="-48" y1="44" x2="48" y2="44" /><line x1="0" y1="44" x2="0" y2="104" />
                      <line x1="-48" y1="44" x2="-72" y2="92" /><line x1="-72" y1="92" x2="-60" y2="140" />
                      <line x1="48" y1="44" x2="72" y2="92" /><line x1="72" y1="92" x2="60" y2="140" />
                      <line x1="-28" y1="104" x2="28" y2="104" />
                    </g>
                    <g transform="translate(200 20)">
                      <circle cx="0" cy="20" r="16" fill="#ffffff" fillOpacity="0.92" />
                      <g fill="#9ec5ff"><circle cx="-48" cy="44" r="5" /><circle cx="48" cy="44" r="5" /><circle cx="-72" cy="92" r="5" /><circle cx="72" cy="92" r="5" /><circle cx="-60" cy="140" r="5" /><circle cx="60" cy="140" r="5" /><circle cx="0" cy="44" r="5" /><circle cx="-28" cy="104" r="5" /><circle cx="28" cy="104" r="5" /></g>
                    </g>
                    <path d="M150 56a18 18 0 0 1 16-10" fill="none" stroke="#34d399" strokeWidth="2.5" />
                  </svg>
                ),
                title: "자세 분석",
                desc: "상체 기울기와 어깨 균형, 손동작 빈도를 인식해 흔들림 없이 안정적인 면접 자세를 잡아 줍니다.",
              },
            ].map((f) => (
              <div key={f.title} className="navy-card rounded-2xl overflow-hidden border-2 border-transparent hover:border-[hsl(var(--accent))/0.35] hover:shadow-xl hover:-translate-y-1.5 transition-all duration-200 group">
                <div className="relative aspect-[2/1] overflow-hidden">{f.art}</div>
                <div className="p-7">
                  <h3 className="font-bold text-[hsl(var(--primary))] mb-2.5 text-xl">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed break-keep">{f.desc}</p>
                </div>
              </div>
            ))}

            {/* 자기소개서 맞춤 질문 — 가운데 정렬된 강조 카드 */}
            <div className="navy-card rounded-2xl overflow-hidden border-2 border-transparent hover:border-[hsl(var(--accent))/0.35] hover:shadow-xl hover:-translate-y-1.5 transition-all duration-200 group w-full sm:col-span-2 sm:max-w-md sm:mx-auto">
              <div className="relative aspect-[2/1] overflow-hidden">
                <svg className="absolute inset-0 w-full h-full transition-transform duration-300 group-hover:scale-105" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice">
                  <defs>
                    <linearGradient id="artCoverBg" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#15294d" /><stop offset="1" stopColor="#2b4f93" />
                    </linearGradient>
                  </defs>
                  <rect width="400" height="200" fill="url(#artCoverBg)" />
                  <g transform="translate(96 26)">
                    <rect width="124" height="152" rx="10" fill="#ffffff" fillOpacity="0.95" />
                    <rect x="18" y="20" width="60" height="10" rx="5" fill="#1e3a6e" />
                    <g fill="#9aa7bd"><rect x="18" y="44" width="88" height="7" rx="3.5" /><rect x="18" y="60" width="88" height="7" rx="3.5" /><rect x="18" y="76" width="64" height="7" rx="3.5" /><rect x="18" y="100" width="88" height="7" rx="3.5" /><rect x="18" y="116" width="88" height="7" rx="3.5" /><rect x="18" y="132" width="56" height="7" rx="3.5" /></g>
                  </g>
                  <g transform="translate(228 86)">
                    <rect width="98" height="72" rx="16" fill="#3b82f6" />
                    <path d="M26 72l0 24l26 -24z" fill="#3b82f6" />
                    <text x="49" y="50" textAnchor="middle" fontSize="46" fontWeight="700" fill="#ffffff" fontFamily="sans-serif">?</text>
                  </g>
                  <path d="M318 36l5 13l13 5l-13 5l-5 13l-5 -13l-13 -5l13 -5z" fill="#fcd34d" />
                </svg>
              </div>
              <div className="p-7">
                <h3 className="font-bold text-[hsl(var(--primary))] mb-2.5 text-xl">자기소개서 맞춤 질문</h3>
                <p className="text-sm text-muted-foreground leading-relaxed break-keep">
                  면접을 시작하면 먼저 자기소개서를 작성합니다. AI가 그 내용을 분석해 나에게 꼭 맞는 첫 질문을 만들고, 내 답변에 따라 꼬리 질문을 이어서 던집니다.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 핵심 엔진 아래: 실시간 분석(링) + 결과 리포트 쇼케이스 */}
      <AnalysisShowcase />
      <ResultShowcase />

      {/* How it works */}
      <div className="navy-gradient py-16 px-8">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">진행 방식</p>
            <h2 className="text-2xl font-bold text-white">3단계로 완성하는 면접 준비</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-6 relative">
            <div className="hidden md:block absolute top-8 left-[calc(33%-16px)] right-[calc(33%-16px)] h-px bg-white/20" />
            {[
              { step: "01", title: "자기소개서 작성", desc: "성장과정·지원동기·장단점·입사 후 포부를 작성하면 AI가 내용을 분석해 맞춤 질문을 준비합니다." },
              { step: "02", title: "AI 모의면접 진행", desc: "실전과 동일한 환경에서 면접을 진행합니다. AI가 답변을 바탕으로 꼬리 질문을 생성합니다." },
              { step: "03", title: "멀티모달 성과 리포트", desc: "시선·표정·음성·자세를 종합한 리포트와 개선 가이드를 즉시 제공합니다." },
            ].map((s) => (
              <div key={s.step} className="text-center">
                <div className="w-16 h-16 rounded-full bg-white/10 border border-white/20 flex items-center justify-center mx-auto mb-4">
                  <span className="text-white font-bold text-lg">{s.step}</span>
                </div>
                <h3 className="text-white font-semibold mb-2 text-sm">{s.title}</h3>
                <p className="text-white/55 text-xs leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── PREP ─────────────────────────── */

function PrepScreen({
  videoRef,
  onBack,
  onStart,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onBack: () => void;
  onStart: (sections: CoverSections, topic: string, count: number) => void | Promise<void>;
}) {
  const [camReady, setCamReady] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [checked, setChecked] = useState([false, false, false]);
  const [sections, setSections] = useState<CoverSections>({});
  const [submitting, setSubmitting] = useState(false);

  // 직무·경력 설정 — 선택 사항. 비워 두면 일반 면접("면접")으로 진행된다.
  const [roleSelect, setRoleSelect] = useState(""); // 드롭다운 선택값("" | 직무명 | JOB_CUSTOM)
  const [roleCustom, setRoleCustom] = useState(""); // "기타" 선택 시 직접 입력값
  const [career, setCareer] = useState<"junior" | "senior">("junior");
  const [years, setYears] = useState(""); // 경력 연차(경력 선택 시)
  const [questionCount, setQuestionCount] = useState<number>(DEFAULT_QUESTION_COUNT); // 이번 면접 질문 개수

  // 실제 직무명: "기타"면 직접 입력값, 아니면 드롭다운 값
  const jobRole = roleSelect === JOB_CUSTOM ? roleCustom : roleSelect;

  const allChecked = checked.every(Boolean);

  // 자기소개서를 작성해야 면접을 시작할 수 있다(맞춤 질문의 근거가 되므로 필수).
  // 모든 문항 합계가 최소 글자 수 이상이어야 '작성함'으로 본다.
  const MIN_COVER_LETTER_CHARS = 50;
  const coverLetterChars = COVER_SECTIONS.reduce(
    (sum, sec) => sum + (sections[sec.key] || "").trim().length,
    0,
  );
  const coverLetterFilled = coverLetterChars >= MIN_COVER_LETTER_CHARS;

  const canStart = allChecked && coverLetterFilled;

  const handleStart = async () => {
    if (!canStart) return;
    setSubmitting(true);
    const topic = buildTopic(jobRole, career, years);
    await onStart(sections, topic, questionCount);
    // 성공 시 부모가 화면을 전환하므로 이 컴포넌트는 언마운트된다.
    setSubmitting(false);
  };

  useEffect(() => {
    const interval = setInterval(() => setMicLevel(Math.random() * 80 + 10), 300);
    return () => clearInterval(interval);
  }, []);

  const toggle = (i: number) =>
    setChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)));

  return (
    <div className="min-h-screen flex flex-col screen-enter">
      <nav className="navy-gradient px-6 py-4 flex items-center gap-4 shadow-lg">
        <button
          data-testid="button-back-prep"
          onClick={onBack}
          className="text-white/80 hover:text-white transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="m15 18-6-6 6-6"/>
          </svg>
        </button>
        <span className="text-white font-bold text-lg">면접 환경 준비</span>
        <div className="ml-auto flex items-center gap-2 bg-white/10 px-3 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-yellow-400 recording-dot" />
          <span className="text-white/90 text-xs font-medium">준비 중</span>
        </div>
      </nav>

      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-[hsl(var(--primary))] mb-2">직무 설정 & 자기소개서 작성</h2>
          <p className="text-muted-foreground">지원 직무와 자기소개서를 입력하면 AI가 더 날카로운 맞춤 질문을 만듭니다. 장치도 함께 확인해 주세요.</p>
        </div>

        {/* 직무·경력 설정 — 면접관이 먼저 알아야 할 정보라 자기소개서보다 위에 둔다.
            선택 사항이며, 비워 두면 일반 면접으로 진행된다. */}
        <div className="navy-card rounded-2xl p-6 mb-8 text-left">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="font-bold text-[hsl(var(--primary))]">직무 / 지원 포지션</h3>
            <span className="text-xs text-muted-foreground">선택 사항</span>
          </div>
          <p className="text-muted-foreground text-sm mb-4">
            지원 직무와 경력 수준을 설정하면 그 직무에 맞는 전문 질문이 생성됩니다. (설정하지 않으면 일반 면접으로 진행됩니다)
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            {/* 직무 드롭다운 (+ 기타 직접 입력) */}
            <div>
              <label className="font-semibold text-sm text-foreground block mb-1.5">직무</label>
              <select
                data-testid="select-job-role"
                value={roleSelect}
                onChange={(e) => setRoleSelect(e.target.value)}
                className="w-full rounded-xl border border-[hsl(var(--border))] bg-background p-3 text-sm focus:outline-none focus:border-[hsl(var(--primary))]"
              >
                <option value="">직무를 선택하세요 (선택)</option>
                {JOB_ROLE_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value={JOB_CUSTOM}>기타 (직접 입력)</option>
              </select>
              {roleSelect === JOB_CUSTOM && (
                <input
                  data-testid="input-job-custom"
                  type="text"
                  value={roleCustom}
                  onChange={(e) => setRoleCustom(e.target.value.slice(0, 40))}
                  maxLength={40}
                  placeholder="예: AI 리서치 엔지니어"
                  className="mt-2 w-full rounded-xl border border-[hsl(var(--border))] bg-background p-3 text-sm focus:outline-none focus:border-[hsl(var(--primary))]"
                />
              )}
            </div>

            {/* 경력 수준: 신입 / 경력(연차) */}
            <div>
              <label className="font-semibold text-sm text-foreground block mb-1.5">경력 수준</label>
              <div className="flex items-center gap-4 h-[46px]">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="career"
                    data-testid="radio-career-junior"
                    checked={career === "junior"}
                    onChange={() => setCareer("junior")}
                    className="accent-[hsl(var(--primary))]"
                  />
                  신입
                </label>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="career"
                    data-testid="radio-career-senior"
                    checked={career === "senior"}
                    onChange={() => setCareer("senior")}
                    className="accent-[hsl(var(--primary))]"
                  />
                  경력
                </label>
                {career === "senior" && (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      data-testid="input-years"
                      value={years}
                      onChange={(e) => setYears(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                      min={0}
                      max={50}
                      placeholder="연차"
                      className="w-20 rounded-xl border border-[hsl(var(--border))] bg-background p-2.5 text-sm focus:outline-none focus:border-[hsl(var(--primary))]"
                    />
                    <span className="text-sm text-muted-foreground">년</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 질문 개수 — 이번 면접에서 진행할 질문 수 */}
          <div className="mt-5 pt-5 border-t border-[hsl(var(--border))]">
            <label className="font-semibold text-sm text-foreground block mb-2">질문 개수</label>
            <div className="flex items-center gap-2">
              {QUESTION_COUNT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  data-testid={`button-qcount-${n}`}
                  onClick={() => setQuestionCount(n)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                    questionCount === n
                      ? "navy-gradient text-white shadow"
                      : "bg-background border border-[hsl(var(--border))] text-foreground hover:border-[hsl(var(--primary))]"
                  }`}
                >
                  {n}개
                </button>
              ))}
              <span className="ml-1 text-xs text-muted-foreground">질문이 많을수록 면접이 길어집니다.</span>
            </div>
          </div>
        </div>

        {/* 자기소개서 문항 작성 — 입력 내용을 AI가 분석해 맞춤 질문을 생성한다 */}
        <div className="navy-card rounded-2xl p-6 mb-8 text-left">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="font-bold text-[hsl(var(--primary))]">자기소개서 문항</h3>
            <span className="text-xs text-[hsl(var(--accent))] font-semibold">필수</span>
          </div>
          <p className="text-muted-foreground text-sm mb-4">
            각 항목을 1,000~2,000자 이내로 작성하세요. (맞춤 질문의 근거가 되므로 최소 한 문항 이상 작성해야 시작할 수 있습니다 · 성장과정은 질문 비중이 낮습니다)
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            {COVER_SECTIONS.map((sec) => {
              const len = (sections[sec.key] || "").trim().length;
              return (
                <div key={sec.key}>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <label className="font-semibold text-sm text-foreground">{sec.label}</label>
                    <span
                      className={`text-xs tabular-nums ${
                        len >= 1000 ? "text-[hsl(var(--accent))]" : len > 0 ? "text-orange-500" : "text-muted-foreground"
                      }`}
                    >
                      {len.toLocaleString()}자
                    </span>
                  </div>
                  <textarea
                    value={sections[sec.key] || ""}
                    onChange={(e) =>
                      setSections((s) => ({ ...s, [sec.key]: e.target.value.slice(0, 2000) }))
                    }
                    rows={4}
                    maxLength={2000}
                    placeholder={sec.placeholder}
                    className="w-full rounded-xl border border-[hsl(var(--border))] bg-background p-3 text-sm resize-y focus:outline-none focus:border-[hsl(var(--primary))]"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid md:grid-cols-5 gap-6">
          {/* Webcam area */}
          <div className="md:col-span-3">
            <div className="navy-card rounded-2xl overflow-hidden shadow-lg">
              <div className="relative aspect-video webcam-placeholder">
                {/* -scale-x-100: 화면 표시만 좌우반전(셀피 미러). 분석 좌표는
                    poseAnalyzer/faceAnalyzer 에서 별도로 보정하므로 영향 없음. */}
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  onPlay={() => setCamReady(true)}
                  className="absolute inset-0 w-full h-full object-cover -scale-x-100"
                />
                {!camReady && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-white/60">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M23 7 16 12 23 17z"/>
                      <rect x="1" y="5" width="15" height="14" rx="2"/>
                    </svg>
                    <p className="mt-3 text-sm">카메라 권한을 허용해 주세요</p>
                  </div>
                )}
                <div className="absolute top-3 left-3 w-8 h-8 border-l-2 border-t-2 border-white/40 rounded-tl" />
                <div className="absolute top-3 right-3 w-8 h-8 border-r-2 border-t-2 border-white/40 rounded-tr" />
                <div className="absolute bottom-3 left-3 w-8 h-8 border-l-2 border-b-2 border-white/40 rounded-bl" />
                <div className="absolute bottom-3 right-3 w-8 h-8 border-r-2 border-b-2 border-white/40 rounded-br" />
              </div>
            </div>
          </div>

          {/* Checks panel */}
          <div className="md:col-span-2 flex flex-col gap-4">
            {/* Camera status */}
            <div className="navy-card rounded-2xl p-5">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${camReady ? "bg-green-100" : "bg-yellow-100"}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={camReady ? "#16a34a" : "#ca8a04"} strokeWidth="2.2">
                    <path d="M23 7 16 12 23 17z"/>
                    <rect x="1" y="5" width="15" height="14" rx="2"/>
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-sm text-[hsl(var(--primary))]">카메라</p>
                  <p className={`text-xs ${camReady ? "text-green-600" : "text-yellow-600"}`}>
                    {camReady ? "정상 작동" : "확인 중..."}
                  </p>
                </div>
                {camReady && (
                  <div className="ml-auto w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                )}
              </div>
            </div>

            {/* Microphone level */}
            <div className="navy-card rounded-2xl p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                </div>
                <div>
                  <p className="font-semibold text-sm text-[hsl(var(--primary))]">마이크</p>
                  <p className="text-xs text-blue-600">입력 감지 중</p>
                </div>
              </div>
              <div className="flex gap-1 items-end h-8">
                {Array.from({ length: 20 }).map((_, i) => {
                  const barH = Math.min(100, micLevel * (0.5 + Math.sin(i * 0.7) * 0.5));
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-sm transition-all duration-150"
                      style={{
                        height: `${Math.max(15, barH)}%`,
                        backgroundColor:
                          i < micLevel / 5 ? "hsl(var(--accent))" : "hsl(var(--border))",
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Checklist — all 3 required */}
            <div className="navy-card rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="font-semibold text-sm text-[hsl(var(--primary))]">환경 체크리스트</p>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${allChecked ? "bg-green-100 text-green-700" : "bg-orange-50 text-orange-600"}`}>
                  {checked.filter(Boolean).length} / 3
                </span>
              </div>
              {[
                "주변이 조용한 환경인가요?",
                "밝은 조명이 얼굴 정면을 향하고 있나요?",
                "카메라가 눈 높이에 맞게 위치해 있나요?",
              ].map((item, i) => (
                <label
                  key={item}
                  className="flex items-center gap-2.5 text-sm text-foreground mb-2.5 cursor-pointer group"
                >
                  <div
                    onClick={() => toggle(i)}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      checked[i]
                        ? "bg-[hsl(var(--primary))] border-[hsl(var(--primary))]"
                        : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]"
                    }`}
                  >
                    {checked[i] && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </div>
                  <span
                    className={`transition-colors ${
                      checked[i] ? "line-through text-muted-foreground" : "group-hover:text-[hsl(var(--primary))]"
                    }`}
                  >
                    {item}
                  </span>
                </label>
              ))}
              {!allChecked && (
                <p className="text-xs text-orange-500 mt-1">모든 항목을 확인해야 면접을 시작할 수 있습니다.</p>
              )}
              {allChecked && !coverLetterFilled && (
                <p className="text-xs text-orange-500 mt-1">자기소개서를 작성해야 면접을 시작할 수 있습니다.</p>
              )}
            </div>

            <button
              data-testid="button-start-interview"
              onClick={handleStart}
              disabled={!canStart || submitting}
              className={`mt-auto font-bold py-4 rounded-2xl transition-all duration-200 ${
                canStart && !submitting
                  ? "navy-gradient text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 cursor-pointer"
                  : "bg-[hsl(var(--muted))] text-muted-foreground cursor-not-allowed"
              }`}
            >
              {submitting
                ? "자기소개서 분석 중..."
                : !allChecked
                ? "체크리스트를 모두 완료해 주세요"
                : !coverLetterFilled
                ? "자기소개서를 작성해 주세요"
                : "면접 시작하기"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── INTERVIEW ─────────────────────────── */

// 브라우저 기본 TTS (폴백). OpenAI TTS 실패 시에만 사용.
function speakKoBrowser(text: string, onStart: () => void, onEnd: () => void) {
  const synth = window.speechSynthesis;
  if (!synth || !text) {
    onEnd();
    return;
  }
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    const ko = synth.getVoices().find((v) => (v.lang || "").toLowerCase().startsWith("ko"));
    if (ko) u.voice = ko;
    u.rate = 1.0;
    u.onstart = onStart;
    u.onend = onEnd;
    u.onerror = onEnd;
    synth.speak(u);
  } catch {
    onEnd();
  }
}

function InterviewScreen({
  videoRef,
  question,
  questionIndex,
  totalQuestions,
  timer,
  feedbackOpen,
  onToggleFeedback,
  busy,
  poseScore,
  exprScore,
  gazeScore,
  onNext,
  onEnd,
  onSpeakingChange,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  question: string;
  questionIndex: number;
  totalQuestions: number;
  timer: string;
  feedbackOpen: boolean;
  onToggleFeedback: () => void;
  busy: boolean;
  poseScore: number | null;
  exprScore: number | null;
  gazeScore: number | null;
  onNext: () => void;
  onEnd: () => void;
  /** AI 면접관 질문 음성(TTS) 재생 여부 변화 → 부모가 음성 분석을 일시 정지/재개한다. */
  onSpeakingChange: (speaking: boolean) => void;
}) {
  const isLast = questionIndex === totalQuestions - 1;

  // AI 면접관이 질문을 음성으로 읽어준다.
  // 1순위: OpenAI TTS(/api/tts, 자연스러운 한국어) → 실패 시 브라우저 기본 TTS 폴백.
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  // /interviewer.jpg(한국인 면접관 사진)가 있으면 사진을, 없으면 심볼 아바타로 폴백.
  const [imgOk, setImgOk] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const playQuestion = useCallback(
    async (text: string) => {
      stopSpeaking();
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onplay = () => setSpeaking(true);
          const done = () => {
            setSpeaking(false);
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
          };
          audio.onended = done;
          audio.onerror = done;
          await audio.play();
          return;
        }
      } catch {
        /* 서버/네트워크 오류 → 아래 브라우저 TTS 폴백 */
      }
      speakKoBrowser(text, () => setSpeaking(true), () => setSpeaking(false));
    },
    [stopSpeaking]
  );

  useEffect(() => {
    if (busy || muted || !question) return;
    playQuestion(question);
    return () => stopSpeaking();
  }, [question, busy, muted, playQuestion, stopSpeaking]);

  // 질문 음성 재생 상태를 부모로 올려 음성 분석을 게이트한다.
  // (재생 중이면 분석 일시정지 → 질문 음성이 점수에 섞이지 않게.)
  // 언마운트 시에는 분석이 멈춰있지 않도록 false 로 되돌린다.
  useEffect(() => {
    onSpeakingChange(speaking);
  }, [speaking, onSpeakingChange]);
  useEffect(() => {
    return () => onSpeakingChange(false);
  }, [onSpeakingChange]);

  const replayQuestion = () => {
    if (!muted && question) playQuestion(question);
  };

  // 실시간 점수에서 간단한 피드백 항목을 만든다(고정 문구 대신 실제 신호 기반).
  const liveFeedback: { type: "good" | "warn" | "tip"; text: string }[] = [];
  if (gazeScore != null)
    liveFeedback.push(
      gazeScore >= 75
        ? { type: "good", text: "카메라를 잘 응시하고 있습니다." }
        : { type: "warn", text: "시선이 카메라에서 벗어나고 있습니다." }
    );
  if (exprScore != null)
    liveFeedback.push(
      exprScore >= 80
        ? { type: "good", text: "자연스러운 표정을 유지하고 있습니다." }
        : { type: "tip", text: "표정을 조금 더 편안하게 가져가 보세요." }
    );
  if (poseScore != null)
    liveFeedback.push(
      poseScore >= 75
        ? { type: "good", text: "안정적인 자세를 유지하고 있습니다." }
        : { type: "tip", text: "상체를 중앙에 두고 자세를 안정적으로 유지해 보세요." }
    );
  if (liveFeedback.length === 0)
    liveFeedback.push({ type: "tip", text: "분석을 준비하고 있습니다. 잠시만 기다려 주세요." });

  return (
    <div className="min-h-screen flex flex-col bg-[hsl(222,47%,8%)] screen-enter">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/30 px-3 py-1.5 rounded-full">
            <span className="w-2 h-2 rounded-full bg-red-500 recording-dot" />
            <span className="text-red-300 text-xs font-semibold">녹화 중</span>
          </div>
          <div className="text-white/60 text-sm font-mono">{timer}</div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-white/60 text-sm">
            {questionIndex + 1} / {totalQuestions}
          </span>
          <div className="flex gap-1">
            {Array.from({ length: totalQuestions }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-6 rounded-full transition-colors ${
                  i <= questionIndex ? "bg-[hsl(var(--accent))]" : "bg-white/20"
                }`}
              />
            ))}
          </div>
        </div>

        <button
          data-testid="button-feedback-toggle"
          onClick={onToggleFeedback}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${
            feedbackOpen
              ? "bg-[hsl(var(--accent))] text-white shadow-lg"
              : "bg-white/10 text-white/80 hover:bg-white/15"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          실시간 피드백
          {feedbackOpen && (
            <span className="w-4 h-4 rounded-full bg-white/20 text-[10px] flex items-center justify-center">
              {liveFeedback.length}
            </span>
          )}
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 flex gap-0 overflow-hidden">
        {/* Left 70% */}
        <div className="flex-[7] flex flex-col p-6 gap-5">
          <div className="order-2 flex-[5] min-h-0 rounded-2xl border border-white/10 bg-[hsl(222,47%,12%)] overflow-y-auto relative flex flex-col items-center justify-center gap-4 py-4 shadow-xl">
            <div
              className="absolute inset-0 opacity-5"
              style={{
                backgroundImage:
                  "linear-gradient(hsl(213,90%,60%) 1px, transparent 1px), linear-gradient(90deg, hsl(213,90%,60%) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
            />
            <div className="relative z-10 flex flex-col items-center gap-4">
              <div className="relative">
                {/* 말하는 동안 글로우가 강해진다 */}
                <div
                  className={`absolute inset-0 rounded-full bg-[hsl(var(--accent))/0.3] pulse-ring scale-125 transition-opacity ${
                    speaking ? "opacity-100" : "opacity-25"
                  }`}
                />
                {speaking && (
                  <div className="absolute -inset-4 rounded-full bg-[hsl(var(--accent))/0.25] blur-2xl animate-pulse" />
                )}
                <div
                  className={`relative w-28 h-28 rounded-full overflow-hidden flex items-center justify-center shadow-2xl border-4 transition-all duration-300 ${
                    imgOk ? "" : "navy-gradient"
                  } ${speaking ? "border-[hsl(var(--accent))/0.5] scale-105" : "border-white/10"}`}
                >
                  {imgOk ? (
                    <img
                      src="/interviewer.jpg"
                      alt="AI 면접관"
                      className="w-full h-full object-cover"
                      onError={() => setImgOk(false)}
                    />
                  ) : (
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5">
                      <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z" />
                      <path d="M20.84 14a8 8 0 0 1-15.68 0" />
                      <line x1="12" y1="22" x2="12" y2="18" />
                    </svg>
                  )}
                </div>
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-lg">AI 면접관</p>
                <p className="text-white/50 text-sm">Kim AI · 인사담당 매니저</p>
                <div className="flex items-center justify-center gap-2 mt-2.5">
                  <button
                    onClick={replayQuestion}
                    disabled={muted}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-white/80 text-xs font-medium hover:bg-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    🔊 질문 다시 듣기
                  </button>
                  <button
                    onClick={() => setMuted((m) => !m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      muted ? "bg-red-500/20 text-red-300" : "bg-white/10 text-white/60 hover:bg-white/15"
                    }`}
                  >
                    {muted ? "음소거 해제" : "음소거"}
                  </button>
                </div>
                {speaking && (
                  <p className="text-[hsl(var(--accent))] text-xs mt-2 flex items-center justify-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--accent))] recording-dot" />
                    질문하는 중…
                  </p>
                )}
              </div>
            </div>
            <div className="z-10 flex items-center gap-1 h-10">
              {Array.from({ length: 24 }).map((_, i) => (
                <div
                  key={i}
                  className={`w-1 rounded-full transition-colors ${
                    speaking ? "bg-[hsl(var(--accent))]" : "bg-[hsl(var(--accent))/0.35]"
                  }`}
                  style={{
                    height: speaking
                      ? `${14 + Math.abs(Math.sin(i * 0.6)) * 22}px`
                      : `${8 + Math.abs(Math.sin(i * 0.6)) * 6}px`,
                    animation: speaking
                      ? `recordingBlink ${0.6 + (i % 3) * 0.15}s ease-in-out ${i * 0.04}s infinite`
                      : "none",
                  }}
                />
              ))}
            </div>
          </div>

          <div className="order-1 flex-[3] min-h-0 overflow-auto rounded-2xl border border-white/10 bg-[hsl(222,47%,15%)] p-6 shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center">
                <span className="text-white text-xs font-bold">Q</span>
              </div>
              <span className="text-white/60 text-base">질문 {questionIndex + 1}</span>
            </div>
            <p key={questionIndex} className="text-white text-2xl leading-relaxed font-medium screen-enter">
              {busy ? "다음 질문을 생성하는 중입니다..." : question}
            </p>
          </div>
        </div>

        {/* Right 30% */}
        <div className="flex-[3] flex flex-col p-4 pl-0 gap-4">
          <div
            className="rounded-2xl overflow-hidden border border-white/10 shadow-xl relative"
            style={{ aspectRatio: "4/3" }}
          >
            <div className="webcam-placeholder w-full h-full">
              {/* -scale-x-100: 화면 표시만 좌우반전(셀피 미러). 분석 좌표는 별도 보정됨. */}
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover -scale-x-100" />
            </div>
            <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-lg text-white text-xs font-medium">
              나
            </div>
            <div className="absolute top-2 right-2 flex flex-col gap-1">
              {[
                { label: "표정", color: "bg-green-500", value: exprScore },
                { label: "시선", color: "bg-blue-400", value: gazeScore },
                { label: "자세", color: "bg-emerald-400", value: poseScore },
              ].map((tag) => (
                <div
                  key={tag.label}
                  className="flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded text-white text-[10px]"
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${tag.color}`} />
                  {tag.label}
                  {tag.value != null && <span className="font-bold ml-0.5">{tag.value}</span>}
                </div>
              ))}
            </div>
          </div>

          {feedbackOpen && (
            <div className="flex-1 rounded-2xl border border-[hsl(var(--accent))/0.3] bg-[hsl(222,47%,13%)] p-4 shadow-xl overflow-y-auto screen-enter">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-[hsl(var(--accent))] recording-dot" />
                <p className="text-white/90 text-sm font-semibold">실시간 피드백</p>
              </div>
              <div className="flex flex-col gap-2.5">
                {liveFeedback.map((fb, i) => (
                  <div
                    key={i}
                    className={`rounded-xl p-3 text-xs leading-relaxed ${
                      fb.type === "good"
                        ? "bg-green-500/15 border border-green-500/20 text-green-300"
                        : fb.type === "warn"
                        ? "bg-yellow-500/15 border border-yellow-500/20 text-yellow-300"
                        : "bg-blue-500/15 border border-blue-500/20 text-blue-300"
                    }`}
                  >
                    <span className="font-semibold mr-1">
                      {fb.type === "good" ? "✓" : fb.type === "warn" ? "!" : "💡"}
                    </span>
                    {fb.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between gap-4">
        <div className="text-white/40 text-sm">답변 후 '다음' 버튼을 눌러 진행하세요</div>
        <div className="flex items-center gap-3">
          <button
            data-testid="button-end-interview"
            onClick={onEnd}
            className="px-5 py-3 rounded-xl border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/10 transition-colors"
          >
            면접 종료
          </button>
          <button
            data-testid="button-next-question"
            onClick={onNext}
            disabled={busy}
            className="px-6 py-3 rounded-xl navy-gradient text-white text-sm font-bold shadow-lg hover:scale-105 active:scale-100 transition-all duration-150 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {busy ? "생성 중..." : isLast ? "면접 완료" : "다음 질문"}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="m9 18 6-6-6-6"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── RESULT ─────────────────────────── */

// 답변 내용 평가(클로드 채점) 카드. 채점은 비동기로 도착하므로:
//   - answerEval 이 아직 없으면 "분석 중…" 안내
//   - 도착하면 항목별 등급(상/중상/중하/하)+코멘트 + 종합 코멘트
// 점수가 아니라 '참고용 코멘트'임을 명시한다(면접 채점은 본질적으로 주관적).
// 4단계 등급 색상: 상=초록, 중상=연두, 중하=노랑, 하=빨강.
const GRADE_STYLE: Record<string, string> = {
  상: "bg-green-100 text-green-800 border-green-200",
  중상: "bg-lime-100 text-lime-800 border-lime-200",
  중하: "bg-yellow-100 text-yellow-800 border-yellow-200",
  하: "bg-red-100 text-red-700 border-red-200",
};

function AnswerEvalCard({
  answerEval,
  status,
}: {
  answerEval?: AnswerEval;
  status?: AnswerEvalStatus;
}) {
  // 상태 결정: 명시 status 우선, 없으면 데이터 유무로 추론(기록 화면 재사용 대비).
  const effective: AnswerEvalStatus =
    status ?? (answerEval && answerEval.items.length > 0 ? "done" : "loading");

  return (
    <div className="navy-card rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="font-bold text-[hsl(var(--primary))]">답변 내용 평가</h3>
        <span className="text-xs text-muted-foreground bg-[hsl(var(--secondary))] px-2 py-0.5 rounded-full">
          참고용 · AI 채점
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        목소리·표정 같은 전달력과 별개로, 답변 <b>내용</b>을 평가했습니다. 점수가 아닌
        참고용 코멘트로 활용하세요.
      </p>

      {effective === "loading" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          답변 내용을 분석하는 중입니다…
        </div>
      ) : effective === "failed" || !answerEval ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          답변 내용 평가를 불러오지 못했어요. (전달력 점수는 정상 측정됨)
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {answerEval.items.map((it, i) => (
              <div key={i} className="flex items-start gap-3">
                <span
                  className={`flex-shrink-0 min-w-[2.75rem] h-7 px-1.5 rounded-lg border flex items-center justify-center text-sm font-bold ${
                    GRADE_STYLE[it.grade] ?? "bg-gray-100 text-gray-700 border-gray-200"
                  }`}
                >
                  {it.grade}
                </span>
                <div>
                  <p className="text-sm font-semibold text-[hsl(var(--primary))]">{it.label}</p>
                  {it.comment && (
                    <p className="text-sm text-muted-foreground leading-relaxed">{it.comment}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {answerEval.overall && (
            <div className="mt-5 rounded-xl bg-[hsl(var(--secondary))] p-4">
              <p className="text-xs font-semibold text-[hsl(var(--primary))] mb-1">종합 코멘트</p>
              <p className="text-sm text-muted-foreground leading-relaxed">{answerEval.overall}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ResultScreen({
  abandoned,
  result,
  showResults,
  onShowResults,
  onRestart,
}: {
  abandoned: boolean;
  result: InterviewResult | null;
  showResults: boolean;
  onShowResults: () => void;
  onRestart: () => void;
}) {
  const overallScore = result?.overall ?? 0;
  const hasData = !!result && result.scores.length > 0;
  const invalidReason = result?.invalidReason;
  const grade =
    overallScore >= 80
      ? "우수한 성과입니다!"
      : overallScore >= 60
      ? "양호한 성과입니다."
      : "더 연습해 봐요!";

  return (
    <div className="min-h-screen flex flex-col screen-enter">
      <nav className="navy-gradient px-6 py-4 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z"/>
              <path d="M20.84 14a8 8 0 0 1-15.68 0"/>
            </svg>
          </div>
          <span className="text-white font-bold text-lg">InterviewAI</span>
        </div>
        <span className="text-white/80 text-sm font-medium">
          {invalidReason ? "평가 무효" : abandoned ? "면접 중단" : "면접 결과 리포트"}
        </span>
        <button
          data-testid="button-restart"
          onClick={onRestart}
          className="px-4 py-2 bg-white/15 text-white text-sm font-medium rounded-lg hover:bg-white/20 transition-colors"
        >
          처음으로
        </button>
      </nav>

      <div className="flex-1 max-w-5xl mx-auto w-full px-6 py-10">
        {invalidReason ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center screen-enter">
            <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mb-6 shadow-md">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-[hsl(var(--primary))] mb-4">평가가 무효 처리되었습니다</h2>
            <p className="text-lg text-muted-foreground max-w-md mb-2 leading-relaxed">
              {invalidReason}
            </p>
            <p className="text-base text-muted-foreground max-w-md mb-9">
              이 면접은 점수가 매겨지지 않으며 기록에도 저장되지 않습니다.
            </p>
            <div className="flex gap-3">
              <button
                onClick={onRestart}
                className="px-7 py-3.5 text-base border border-[hsl(var(--border))] text-[hsl(var(--primary))] font-semibold rounded-xl hover:bg-[hsl(var(--secondary))] transition-colors"
              >
                처음으로
              </button>
              <button
                onClick={onRestart}
                className="px-7 py-3.5 text-base navy-gradient text-white font-bold rounded-xl shadow hover:shadow-md hover:scale-105 active:scale-100 transition-all duration-150"
              >
                다시 도전하기
              </button>
            </div>
          </div>
        ) : abandoned ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center screen-enter">
            <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mb-6 shadow-md">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-[hsl(var(--primary))] mb-4">면접이 중도 포기되었습니다</h2>
            <p className="text-lg text-muted-foreground max-w-md mb-2 leading-relaxed">
              모든 질문을 완료하지 않아 결과를 분석할 수 없습니다.
            </p>
            <p className="text-base text-muted-foreground max-w-md mb-9">
              정확한 피드백을 받으려면 면접을 끝까지 진행해 주세요.
            </p>
            <div className="flex gap-3">
              <button
                data-testid="button-go-home"
                onClick={onRestart}
                className="px-7 py-3.5 text-base border border-[hsl(var(--border))] text-[hsl(var(--primary))] font-semibold rounded-xl hover:bg-[hsl(var(--secondary))] transition-colors"
              >
                처음으로
              </button>
              <button
                data-testid="button-retry-after-abandon"
                onClick={onRestart}
                className="px-7 py-3.5 text-base navy-gradient text-white font-bold rounded-xl shadow hover:shadow-md hover:scale-105 active:scale-100 transition-all duration-150"
              >
                다시 도전하기
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="navy-card rounded-2xl p-6 mb-6 text-center relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-[hsl(var(--accent))/0.04] rounded-full -translate-y-1/2 translate-x-1/3" />
              <div className="relative z-10">
                <p className="text-muted-foreground text-sm mb-2">종합 점수</p>
                <div className="text-7xl font-bold text-[hsl(var(--primary))] mb-2">{overallScore}</div>
                <div className="inline-flex items-center gap-1.5 bg-green-50 border border-green-200 px-3 py-1.5 rounded-full mb-4">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  <span className="text-green-700 text-sm font-semibold">{grade}</span>
                </div>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  5개 질문에 대한 면접이 완료되었습니다. 아래에서 상세 분석을 확인하세요.
                </p>
                {!showResults && (
                  <button
                    data-testid="button-show-results"
                    onClick={onShowResults}
                    className="mt-5 navy-gradient px-8 py-3.5 rounded-xl text-white font-bold shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 transition-all duration-200"
                  >
                    상세 결과 확인하기
                  </button>
                )}
              </div>
            </div>

            {showResults && !hasData && (
              <div className="navy-card rounded-2xl p-8 text-center text-muted-foreground screen-enter">
                분석 데이터가 충분하지 않습니다. 카메라·마이크 권한을 허용하고 면접을 끝까지 진행하면
                표정·시선·자세·음성 점수가 표시됩니다.
              </div>
            )}

            {showResults && hasData && (
              <div className="screen-enter">
                <div className="grid md:grid-cols-2 gap-5 mb-6">
                  <div className="navy-card rounded-2xl p-6">
                    <h3 className="font-bold text-[hsl(var(--primary))] mb-5">영역별 점수</h3>
                    <div className="flex flex-col gap-4">
                      {result!.scores.map((s) => (
                        <div key={s.name}>
                          <div className="flex justify-between mb-1.5">
                            <span className="text-sm font-medium text-foreground">{s.name}</span>
                            <span className="text-sm font-bold text-[hsl(var(--primary))]">{s.score}점</span>
                          </div>
                          <div className="h-2.5 bg-[hsl(var(--border))] rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-1000 ease-out"
                              style={{ width: `${s.score}%`, backgroundColor: s.color }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="navy-card rounded-2xl p-6">
                    <h3 className="font-bold text-[hsl(var(--primary))] mb-4">역량 레이더</h3>
                    <ResponsiveContainer width="100%" height={220}>
                      <RadarChart data={result!.radar}>
                        <PolarGrid stroke="hsl(214,32%,85%)" />
                        <PolarAngleAxis
                          dataKey="subject"
                          tick={{ fontSize: 11, fill: "hsl(215,25%,50%)" }}
                        />
                        <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickCount={4} />
                        <Radar
                          name="점수"
                          dataKey="A"
                          stroke="hsl(222,47%,23%)"
                          fill="hsl(222,47%,23%)"
                          fillOpacity={0.25}
                          strokeWidth={2}
                        />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="navy-card rounded-2xl p-6">
                  <h3 className="font-bold text-[hsl(var(--primary))] mb-4">AI 피드백 요약</h3>
                  <div className="grid md:grid-cols-2 gap-3">
                    {result!.feedback.map((fb, i) => (
                      <div
                        key={i}
                        className={`rounded-xl p-4 flex items-start gap-3 ${
                          fb.type === "good"
                            ? "bg-green-50 border border-green-200"
                            : "bg-yellow-50 border border-yellow-200"
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            fb.type === "good" ? "bg-green-500" : "bg-yellow-500"
                          }`}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                            {fb.type === "good" ? (
                              <polyline points="20 6 9 17 4 12"/>
                            ) : (
                              <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            )}
                          </svg>
                        </div>
                        <p
                          className={`text-sm leading-relaxed ${
                            fb.type === "good" ? "text-green-800" : "text-yellow-800"
                          }`}
                        >
                          {fb.text}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 flex gap-3 justify-end">
                    <button
                      data-testid="button-download-report"
                      className="px-5 py-2.5 border border-[hsl(var(--border))] text-[hsl(var(--primary))] text-sm font-semibold rounded-xl hover:bg-[hsl(var(--secondary))] transition-colors"
                    >
                      리포트 저장
                    </button>
                    <button
                      data-testid="button-retry"
                      onClick={onRestart}
                      className="px-5 py-2.5 navy-gradient text-white text-sm font-bold rounded-xl shadow hover:shadow-md hover:scale-105 active:scale-100 transition-all duration-150"
                    >
                      다시 연습하기
                    </button>
                  </div>
                </div>

                <AnswerEvalCard
                  answerEval={result!.answerEval}
                  status={result!.answerEvalStatus}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── HISTORY ─────────────────────────── */

// 기록 1건 카드. 답변 내용 평가(answer_eval)가 저장돼 있으면 펼쳐서 볼 수 있다.
function HistoryRecordCard({ record: r }: { record: InterviewRecord }) {
  const [open, setOpen] = useState(false);
  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const hasEval = !!r.answer_eval && (r.answer_eval.items?.length ?? 0) > 0;

  return (
    <div className="navy-card rounded-2xl p-5">
      <div className="flex items-center gap-5">
        <div className="flex flex-col items-center justify-center w-20 shrink-0">
          <div className="text-3xl font-bold text-[hsl(var(--accent))]">{r.overall}</div>
          <div className="text-xs text-muted-foreground">종합점수</div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[hsl(var(--primary))] mb-2">{fmtDate(r.date)}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {r.scores.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-16 shrink-0">{s.name}</span>
                <div className="flex-1 h-1.5 rounded-full bg-[hsl(var(--secondary))] overflow-hidden">
                  <div className="h-full rounded-full bg-[hsl(var(--accent))]" style={{ width: `${s.score}%` }} />
                </div>
                <span className="text-xs tabular-nums text-foreground w-7 text-right">{s.score}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {hasEval && (
        <div className="mt-4 pt-4 border-t border-[hsl(var(--border))]">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-semibold text-[hsl(var(--accent))] hover:underline"
          >
            {open ? "답변 내용 평가 접기 ▲" : "답변 내용 평가 보기 ▼"}
          </button>
          {open && (
            <div className="mt-3 space-y-2.5">
              {r.answer_eval!.items.map((it, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span
                    className={`flex-shrink-0 min-w-[2.5rem] h-6 px-1.5 rounded-md border flex items-center justify-center text-xs font-bold ${
                      GRADE_STYLE[it.grade] ?? "bg-gray-100 text-gray-700 border-gray-200"
                    }`}
                  >
                    {it.grade}
                  </span>
                  <div>
                    <p className="text-xs font-semibold text-[hsl(var(--primary))]">{it.label}</p>
                    {it.comment && (
                      <p className="text-xs text-muted-foreground leading-relaxed">{it.comment}</p>
                    )}
                  </div>
                </div>
              ))}
              {r.answer_eval!.overall && (
                <div className="mt-2 rounded-lg bg-[hsl(var(--secondary))] p-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">{r.answer_eval!.overall}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryScreen({
  userName,
  onBack,
}: {
  userName: string;
  onBack: () => void;
}) {
  const [records, setRecords] = useState<InterviewRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/records")
      .then((r) => (r.ok ? r.json() : { records: [] }))
      .then((d) => setRecords(d.records || []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, []);

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <div className="min-h-screen flex flex-col screen-enter">
      <nav className="navy-gradient px-6 py-4 flex items-center gap-4 shadow-lg">
        <button
          onClick={onBack}
          className="text-white/80 hover:text-white transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span className="text-white font-bold text-lg">내 면접 기록</span>
        <span className="ml-auto text-white/70 text-sm">{userName}</span>
      </nav>

      <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-10">
        {loading ? (
          <div className="text-center py-20 text-muted-foreground">불러오는 중...</div>
        ) : records.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-[hsl(var(--secondary))] flex items-center justify-center mx-auto mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth="1.8">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-muted-foreground">아직 완료한 면접 기록이 없습니다.</p>
            <p className="text-muted-foreground text-sm mt-1">
              면접을 끝까지 진행하면 결과가 여기에 저장됩니다.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">총 {records.length}회의 면접 기록</p>
            {records.map((r) => (
              <HistoryRecordCard key={r.id} record={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── AUTH MODAL ─────────────────────────── */

function AuthModal({
  mode,
  onClose,
  onSuccess,
}: {
  mode: "login" | "signup";
  onClose: () => void;
  onSuccess: (name: string) => void;
}) {
  const [tab, setTab] = useState(mode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 회원가입 시 필수 동의 (이용약관 / 개인정보 수집·이용)
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  // 약관 전문 모달 ("terms" | "privacy" | null)
  const [legalView, setLegalView] = useState<"terms" | "privacy" | null>(null);

  const handleSubmit = async () => {
    if (!email || !password) { setError("이메일과 비밀번호를 입력해 주세요."); return; }
    if (tab === "signup" && !name) { setError("이름을 입력해 주세요."); return; }
    // 비밀번호 정책(서버와 동일): 9자 이상 + 대문자 + 소문자 + 특수기호.
    if (
      tab === "signup" &&
      !(password.length >= 9 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[^A-Za-z0-9]/.test(password))
    ) {
      setError("비밀번호는 9자 이상이며 대문자·소문자·특수기호를 모두 포함해야 합니다.");
      return;
    }
    if (tab === "signup" && (!agreeTerms || !agreePrivacy)) {
      setError("이용약관과 개인정보 수집·이용에 모두 동의해 주세요.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/auth/${tab}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          tab === "signup" ? { name, email, password } : { email, password }
        ),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.msg || "요청에 실패했습니다.");
      onSuccess(data.user.name); // 부모가 모달을 닫고 로그인 상태로 전환
    } catch (err: any) {
      setError(err.message || "오류가 발생했습니다.");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="navy-card rounded-2xl w-full max-w-sm mx-4 p-8 shadow-2xl screen-enter relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>

        <div className="text-center mb-6">
          <div className="w-10 h-10 navy-gradient rounded-xl flex items-center justify-center mx-auto mb-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z"/>
              <path d="M20.84 14a8 8 0 0 1-15.68 0"/>
            </svg>
          </div>
          <h3 className="font-bold text-[hsl(var(--primary))] text-lg">
            {tab === "login" ? "다시 오셨군요" : "InterviewAI 시작하기"}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {tab === "login"
              ? "로그인 후 면접 기록을 이어서 확인하세요."
              : "가입 후 면접 기록을 저장하고 성과를 추적하세요."}
          </p>
        </div>

        <div className="flex bg-[hsl(var(--secondary))] rounded-xl p-1 mb-5">
          {(["login", "signup"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError(""); }}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
                tab === t
                  ? "bg-white text-[hsl(var(--primary))] shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "login" ? "로그인" : "회원가입"}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {tab === "signup" && (
            <input
              data-testid="input-name"
              type="text"
              placeholder="이름"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--accent))]"
            />
          )}
          <input
            data-testid="input-email"
            type="email"
            placeholder="이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--accent))]"
          />
          <input
            data-testid="input-password"
            type="password"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            className="w-full px-4 py-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--accent))]"
          />

          {tab === "signup" && (
            <p className="text-xs text-muted-foreground -mt-1">
              비밀번호는 9자 이상이며 대문자·소문자·특수기호를 모두 포함해야 합니다.
            </p>
          )}

          {tab === "signup" && (
            <div className="flex flex-col gap-2 mt-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  data-testid="checkbox-agree-terms"
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  className="w-4 h-4 accent-[hsl(var(--accent))] cursor-pointer"
                />
                <span>
                  <span className="text-red-500">[필수]</span> 이용약관에 동의합니다.
                </span>
                <button
                  type="button"
                  onClick={() => setLegalView("terms")}
                  className="text-[hsl(var(--accent))] underline hover:no-underline ml-auto"
                >
                  보기
                </button>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  data-testid="checkbox-agree-privacy"
                  type="checkbox"
                  checked={agreePrivacy}
                  onChange={(e) => setAgreePrivacy(e.target.checked)}
                  className="w-4 h-4 accent-[hsl(var(--accent))] cursor-pointer"
                />
                <span>
                  <span className="text-red-500">[필수]</span> 개인정보 수집·이용에 동의합니다.
                </span>
                <button
                  type="button"
                  onClick={() => setLegalView("privacy")}
                  className="text-[hsl(var(--accent))] underline hover:no-underline ml-auto"
                >
                  보기
                </button>
              </label>
            </div>
          )}

          {error && <p className="text-red-500 text-xs px-1">{error}</p>}
          <button
            data-testid="button-auth-submit"
            onClick={handleSubmit}
            disabled={submitting}
            className="mt-1 navy-gradient text-white font-bold py-3 rounded-xl shadow hover:shadow-md hover:scale-105 active:scale-100 transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
          >
            {submitting ? "처리 중..." : tab === "login" ? "로그인" : "회원가입"}
          </button>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          {tab === "login" ? "계정이 없으신가요? " : "이미 계정이 있으신가요? "}
          <button
            onClick={() => { setTab(tab === "login" ? "signup" : "login"); setError(""); }}
            className="text-[hsl(var(--accent))] font-semibold hover:underline"
          >
            {tab === "login" ? "회원가입" : "로그인"}
          </button>
        </p>
      </div>

      {legalView && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => { e.stopPropagation(); setLegalView(null); }}
        >
          <div
            className="navy-card rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
              <h4 className="font-bold text-[hsl(var(--primary))] text-base">
                {legalView === "terms" ? "이용약관" : "개인정보 수집·이용 동의"}
              </h4>
              <button
                onClick={() => setLegalView(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground">
                {legalView === "terms" ? TERMS_OF_SERVICE : PRIVACY_POLICY}
              </pre>
            </div>
            <div className="px-6 py-3 border-t border-[hsl(var(--border))]">
              <button
                onClick={() => {
                  if (legalView === "terms") setAgreeTerms(true);
                  else setAgreePrivacy(true);
                  setLegalView(null);
                }}
                className="w-full navy-gradient text-white font-semibold py-2.5 rounded-xl text-sm hover:shadow-md transition-all"
              >
                동의하고 닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── DELETE ACCOUNT MODAL ─────────────────────── */

function DeleteAccountModal({
  onClose,
  onDeleted,
}: {
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleDelete = async () => {
    if (!password) { setError("비밀번호를 입력해 주세요."); return; }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.msg || "탈퇴 처리에 실패했습니다.");
      }
      onDeleted();
    } catch (err: any) {
      setError(err.message || "오류가 발생했습니다.");
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="navy-card rounded-2xl w-full max-w-sm mx-4 p-8 shadow-2xl screen-enter relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>

        <div className="text-center mb-6">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center mx-auto mb-3">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
          </div>
          <h3 className="font-bold text-[hsl(var(--primary))] text-lg">정말 탈퇴하시겠어요?</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            계정과 <b>모든 면접 기록</b>이 영구적으로 삭제되며,<br />되돌릴 수 없습니다.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium text-muted-foreground px-1">
            본인 확인을 위해 비밀번호를 입력해 주세요.
          </label>
          <input
            data-testid="input-delete-password"
            type="password"
            placeholder="비밀번호"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleDelete()}
            className="w-full px-4 py-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
          />
          {error && <p className="text-red-500 text-xs px-1">{error}</p>}
          <button
            data-testid="button-confirm-delete"
            onClick={handleDelete}
            disabled={submitting}
            className="mt-1 bg-red-500 text-white font-bold py-3 rounded-xl shadow hover:bg-red-600 active:scale-100 transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? "처리 중..." : "회원 탈퇴"}
          </button>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors py-1 disabled:opacity-60"
          >
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
