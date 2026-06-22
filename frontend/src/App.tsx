import { useState, useEffect, useRef, useCallback } from "react";
import { RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer } from "recharts";
import { startPoseAnalyzer, type PoseAnalyzerHandle } from "./poseAnalyzer";
import { startFaceAnalyzer, type FaceAnalyzerHandle } from "./faceAnalyzer";
import { startVoiceAnalyzer, type VoiceAnalyzerHandle } from "./voiceAnalyzer";

type Screen = "home" | "prep" | "interview" | "result" | "history";

// API 호출 실패(키 미설정/네트워크 오류) 시 사용하는 폴백 질문
const QUESTIONS = [
  "자기소개를 간단히 해주세요. 본인의 강점과 지원 동기를 중심으로 말씀해 주세요.",
  "본인이 경험한 가장 도전적인 프로젝트는 무엇이었나요? 어떻게 해결하셨나요?",
  "팀원과 갈등이 생겼을 때 어떻게 해결하셨나요? 구체적인 사례를 말씀해 주세요.",
  "5년 후 본인의 모습은 어떻게 그리고 계신가요?",
  "지원하신 직무와 관련하여 본인의 역량을 어필해 주세요.",
];

// 한 번의 면접에서 진행할 질문 개수 (AI가 동적으로 생성)
const TARGET_QUESTIONS = 5;

// 자기소개서 문항 (백엔드 COVER_LETTER_SECTIONS 와 key 일치)
const COVER_SECTIONS = [
  { key: "growth", label: "성장과정", placeholder: "자라온 환경, 가치관 형성에 영향을 준 경험 등" },
  { key: "motivation", label: "지원동기", placeholder: "이 직무·회사에 지원한 이유" },
  { key: "strength_weakness", label: "자신의 장단점", placeholder: "강점과 약점, 그리고 개선 노력" },
  { key: "aspiration", label: "입사 후 포부", placeholder: "입사 후 이루고 싶은 목표와 성장 계획" },
] as const;

type CoverSections = Record<string, string>;

// ── 면접 기록 (MySQL, /api/records 로 저장·조회) ──────────────
type InterviewRecord = {
  id: number;
  date: string; // ISO (서버 created_at)
  overall: number;
  scores: { name: string; score: number }[];
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

type InterviewResult = {
  overall: number;
  scores: { name: string; score: number; color: string }[];
  radar: { subject: string; A: number }[];
  feedback: { type: "good" | "improve"; text: string }[];
};

// 실제 분석 채널 점수/피드백으로 결과 리포트 데이터를 만든다.
// 측정되지 않은 채널(점수 null)은 제외하고, 종합점수는 측정된 것들의 평균.
function buildResult(scores: ChannelScores, fb: ChannelFeedback): InterviewResult {
  const items = CHANNELS.map((c) => ({ ...c, score: scores[c.key], feedback: fb[c.key] })).filter(
    (c): c is typeof c & { score: number } => c.score != null
  );
  const overall = items.length
    ? Math.round(items.reduce((a, c) => a + c.score, 0) / items.length)
    : 0;
  return {
    overall,
    scores: items.map((c) => ({ name: c.name, score: c.score, color: c.color })),
    radar: items.map((c) => ({ subject: c.radar, A: c.score })),
    feedback: items
      .filter((c) => c.feedback)
      .map((c) => ({
        type: c.score >= 80 ? ("good" as const) : ("improve" as const),
        text: `[${c.name}] ${c.feedback}`,
      })),
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
  const [answer, setAnswer] = useState("");                  // 현재 질문에 대한 답변 메모
  const [busy, setBusy] = useState(false);                   // API 호출 중
  const [poseScore, setPoseScore] = useState<number | null>(null); // 실시간 자세 점수
  const [exprScore, setExprScore] = useState<number | null>(null); // 실시간 표정 점수
  const [gazeScore, setGazeScore] = useState<number | null>(null); // 실시간 시선 점수
  const [result, setResult] = useState<InterviewResult | null>(null); // 최종 결과 리포트

  // 분석기(브라우저 MediaPipe / Web Audio) 핸들 / 세션 ID
  const poseRef = useRef<PoseAnalyzerHandle | null>(null);
  const faceRef = useRef<FaceAnalyzerHandle | null>(null);
  const voiceRef = useRef<VoiceAnalyzerHandle | null>(null);
  const answersRef = useRef<string[]>([]); // 음성 단어수 폴백용(STT 미지원 시) 답변 누적
  const sessionIdRef = useRef<string>("");

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
  const streamRef = useRef<MediaStream | null>(null);

  const navigate = useCallback(
    (to: Screen) => {
      if (animating) return;
      setAnimating(true);
      setTimeout(() => {
        setScreen(to);
        setAnimating(false);
      }, 300);
    },
    [animating]
  );

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

  const handleStartClick = () => {
    if (!isLoggedIn) {
      setAuthModal({ mode: "login", onSuccess: () => navigate("prep") });
    } else {
      navigate("prep");
    }
  };

  // 자기소개서를 분석해 첫 질문을 받고 면접을 시작한다.
  const goToInterview = async (sections: CoverSections) => {
    // 자세 분석용 세션 ID 발급 (면접 화면 진입 시 분석기가 사용)
    sessionIdRef.current = "pose_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    setBusy(true);
    let firstQ = QUESTIONS[0];
    let rt = "";
    let gd = "";
    try {
      const res = await fetch("/api/cover-letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: "면접", sections }),
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
    setAnswer("");
    answersRef.current = []; // 새 면접 시작 → 답변 누적 초기화
    setCurrentQ(0);
    setTimer(0);
    setBusy(false);
    stopCamera();
    navigate("interview");
  };

  // 직전 답변을 바탕으로 다음 질문을 생성한다. 목표 개수에 도달하면 면접 종료.
  const nextQuestion = async () => {
    if (busy) return;
    if (questions.length >= TARGET_QUESTIONS) {
      await endInterview(false);
      return;
    }
    setBusy(true);
    let nextQ = QUESTIONS[questions.length % QUESTIONS.length];
    try {
      const res = await fetch("/api/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer_text: answer,
          topic: "면접",
          previous_questions: asked,
          resume_context: resumeText,
          guidance,
        }),
      });
      const data = await res.json();
      if (data.ok && data.question) nextQ = data.question;
    } catch {
      // 오류 시 폴백 질문 사용
    }
    if (answer.trim()) answersRef.current.push(answer.trim());
    setQuestions((qs) => [...qs, nextQ]);
    setAsked((a) => [...a, nextQ]);
    setAnswer("");
    setCurrentQ((q) => q + 1);
    setBusy(false);
  };

  const endInterview = async (isAbandoned: boolean) => {
    stopCamera();
    if (answer.trim()) answersRef.current.push(answer.trim()); // 마지막 답변 반영

    // 4개 분석기를 종료하고 세션 평균 점수/피드백을 회수한다.
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
    const built = buildResult(scores, fb);
    setResult(built);

    // 끝까지 완료 + 측정된 점수가 하나라도 있으면 기록으로 저장한다(로그인 사용자, 서버 DB).
    // 저장 완료를 await 해서 결과/기록 화면 진입 시 누락(경쟁 조건)을 막는다.
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
        if (!res.ok) console.warn("면접 기록 저장 실패:", res.status);
      } catch {
        console.warn("면접 기록 저장 중 네트워크 오류");
      }
    }
    setAbandoned(isAbandoned);
    setScreen("result");
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
            totalQuestions={TARGET_QUESTIONS}
            timer={fmt(timer)}
            feedbackOpen={feedbackOpen}
            onToggleFeedback={() => setFeedbackOpen((f) => !f)}
            answer={answer}
            onAnswerChange={setAnswer}
            busy={busy}
            poseScore={poseScore}
            exprScore={exprScore}
            gazeScore={gazeScore}
            onNext={nextQuestion}
            onEnd={() => endInterview(true)}
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
      <nav className="navy-gradient px-8 py-4 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z"/>
              <path d="M20.84 14a8 8 0 0 1-15.68 0"/>
            </svg>
          </div>
          <span className="text-white font-bold text-base tracking-tight">InterviewAI</span>
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

        <div className="flex items-center gap-2">
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
                className="px-3 py-1.5 text-white/60 text-sm hover:text-white transition-colors"
              >
                로그아웃
              </button>
              <button
                data-testid="button-delete-account"
                onClick={onDeleteAccount}
                className="px-3 py-1.5 text-white/40 text-sm hover:text-red-300 transition-colors"
              >
                회원 탈퇴
              </button>
            </>
          ) : (
            <>
              <button
                data-testid="button-login"
                onClick={() => onAuth("login")}
                className="px-4 py-2 text-white/90 text-sm font-medium rounded-lg hover:bg-white/10 transition-colors"
              >
                로그인
              </button>
              <button
                data-testid="button-signup"
                onClick={() => onAuth("signup")}
                className="px-4 py-2 bg-white text-[hsl(var(--primary))] text-sm font-semibold rounded-lg hover:bg-white/90 transition-colors shadow-sm"
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

        <div className="relative max-w-6xl mx-auto px-8 py-20 grid md:grid-cols-2 gap-12 items-center">
          {/* Left: Copy */}
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-[hsl(var(--accent))/0.1] border border-[hsl(var(--accent))/0.2] rounded-full mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--accent))] recording-dot" />
              <span className="text-xs font-semibold text-[hsl(var(--accent))]">
                AI 멀티모달 면접 분석 플랫폼
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl font-bold text-[hsl(var(--primary))] leading-[1.15] tracking-tight mb-5">
              실전과 동일한 환경에서<br />
              <span className="text-[hsl(var(--accent))]">면접 역량</span>을 객관적으로<br />
              측정하세요
            </h1>

            <p className="text-base text-muted-foreground leading-relaxed mb-8 max-w-lg">
              시선, 표정, 자세, 음성까지 — AI가 면접관의 시각으로 분석합니다.
              이력서 기반 맞춤 질문과 꼬리 질문으로 실전 대비를 완성하세요.
            </p>

            <div className="flex items-center gap-3 flex-wrap">
              <button
                data-testid="button-start"
                onClick={onStart}
                className="navy-gradient px-7 py-3.5 rounded-xl text-white font-bold text-sm shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 transition-all duration-200 flex items-center gap-2"
              >
                면접 시작하기
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="m9 18 6-6-6-6"/>
                </svg>
              </button>
              {!isLoggedIn && (
                <button
                  onClick={() => onAuth("login")}
                  className="px-5 py-3.5 text-sm font-medium text-[hsl(var(--primary))] border border-[hsl(var(--border))] rounded-xl hover:bg-[hsl(var(--secondary))] transition-colors"
                >
                  이미 계정이 있나요?
                </button>
              )}
            </div>

            <div className="mt-8 flex items-center gap-6">
              {[
                { label: "이력서 기반 맞춤 질문" },
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
          </div>

          {/* Right: Feature preview panel */}
          <div className="hidden md:block">
            <div className="navy-card rounded-2xl p-6 shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-[hsl(var(--accent))/0.05] rounded-full -translate-y-1/2 translate-x-1/2" />
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 navy-gradient rounded-lg flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>
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
                {[
                  { label: "시선 안정성", val: 74, color: "bg-[hsl(213,90%,60%)]" },
                  { label: "표정 자신감", val: 82, color: "bg-[hsl(222,47%,35%)]" },
                  { label: "자세 균형", val: 88, color: "bg-emerald-500" },
                  { label: "발화 명확성", val: 79, color: "bg-violet-500" },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="flex justify-between mb-1">
                      <span className="text-xs text-muted-foreground">{item.label}</span>
                      <span className="text-xs font-bold text-[hsl(var(--primary))]">{item.val}</span>
                    </div>
                    <div className="h-1.5 bg-[hsl(var(--border))] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${item.color}`} style={{ width: `${item.val}%` }} />
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
          </div>
        </div>
      </div>

      {/* Features grid */}
      <div className="bg-white py-16 px-8 border-t border-[hsl(var(--border))]">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-xs font-semibold text-[hsl(var(--accent))] uppercase tracking-widest mb-3">핵심 기능</p>
            <h2 className="text-2xl font-bold text-[hsl(var(--primary))]">
              합격을 만드는 4가지 분석 엔진
            </h2>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                ),
                title: "시선 & 표정 분석",
                desc: "눈동자 방향과 표정 변화를 프레임 단위로 추적해 긴장도와 자신감 지표를 산출합니다.",
                tag: "CV 모델",
              },
              {
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                ),
                title: "음성 & 발화 분석",
                desc: "말 속도, 억양, 휴지(pause) 패턴을 분석해 발음 명확성과 논리적 전달력을 평가합니다.",
                tag: "STT 엔진",
              },
              {
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                ),
                title: "자세 & 제스처 분석",
                desc: "상체 기울기, 어깨 위치, 손동작 빈도를 인식해 안정적인 면접 태도를 코칭합니다.",
                tag: "Pose 추정",
              },
              {
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                  </svg>
                ),
                title: "이력서 기반 질문 생성",
                desc: "업로드한 이력서와 JD를 분석해 직무·경력에 최적화된 면접 질문을 자동으로 생성합니다.",
                tag: "LLM 기반",
              },
            ].map((f) => (
              <div key={f.title} className="navy-card rounded-2xl p-5 hover:shadow-lg transition-shadow group">
                <div className="w-10 h-10 navy-gradient rounded-xl flex items-center justify-center text-white mb-4 group-hover:scale-110 transition-transform">
                  {f.icon}
                </div>
                <div className="inline-flex mb-2">
                  <span className="text-[10px] font-semibold text-[hsl(var(--accent))] bg-[hsl(var(--accent))/0.1] px-2 py-0.5 rounded-full">
                    {f.tag}
                  </span>
                </div>
                <h3 className="font-semibold text-[hsl(var(--primary))] mb-2 text-sm">{f.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

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
              { step: "01", title: "이력서 업로드 & 직무 설정", desc: "이력서와 지원 직무를 등록하면 AI가 맞춤형 예상 질문 세트를 구성합니다." },
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
  onStart: (sections: CoverSections) => void | Promise<void>;
}) {
  const [camReady, setCamReady] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [checked, setChecked] = useState([false, false, false]);
  const [sections, setSections] = useState<CoverSections>({});
  const [submitting, setSubmitting] = useState(false);

  const allChecked = checked.every(Boolean);

  const handleStart = async () => {
    setSubmitting(true);
    await onStart(sections);
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
          <h2 className="text-2xl font-bold text-[hsl(var(--primary))] mb-2">자기소개서 작성 & 장치 확인</h2>
          <p className="text-muted-foreground">자기소개서를 작성하면 AI가 맞춤 질문을 만듭니다. 장치도 함께 확인해 주세요.</p>
        </div>

        {/* 자기소개서 문항 작성 — 입력 내용을 AI가 분석해 맞춤 질문을 생성한다 */}
        <div className="navy-card rounded-2xl p-6 mb-8 text-left">
          <h3 className="font-bold text-[hsl(var(--primary))] mb-1">자기소개서 문항</h3>
          <p className="text-muted-foreground text-sm mb-4">
            각 항목을 1,000~2,000자 이내로 작성하세요. (작성하지 않고 시작해도 됩니다 · 성장과정은 질문 비중이 낮습니다)
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
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  onPlay={() => setCamReady(true)}
                  className="absolute inset-0 w-full h-full object-cover"
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
            </div>

            <button
              data-testid="button-start-interview"
              onClick={handleStart}
              disabled={!allChecked || submitting}
              className={`mt-auto font-bold py-4 rounded-2xl transition-all duration-200 ${
                allChecked && !submitting
                  ? "navy-gradient text-white shadow-lg hover:shadow-xl hover:scale-105 active:scale-100 cursor-pointer"
                  : "bg-[hsl(var(--muted))] text-muted-foreground cursor-not-allowed"
              }`}
            >
              {submitting
                ? "자기소개서 분석 중..."
                : allChecked
                ? "면접 시작하기"
                : "체크리스트를 모두 완료해 주세요"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── INTERVIEW ─────────────────────────── */

function InterviewScreen({
  videoRef,
  question,
  questionIndex,
  totalQuestions,
  timer,
  feedbackOpen,
  onToggleFeedback,
  answer,
  onAnswerChange,
  busy,
  poseScore,
  exprScore,
  gazeScore,
  onNext,
  onEnd,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  question: string;
  questionIndex: number;
  totalQuestions: number;
  timer: string;
  feedbackOpen: boolean;
  onToggleFeedback: () => void;
  answer: string;
  onAnswerChange: (v: string) => void;
  busy: boolean;
  poseScore: number | null;
  exprScore: number | null;
  gazeScore: number | null;
  onNext: () => void;
  onEnd: () => void;
}) {
  const isLast = questionIndex === totalQuestions - 1;

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
          <div className="flex-1 rounded-2xl border border-white/10 bg-[hsl(222,47%,12%)] overflow-hidden relative flex flex-col items-center justify-center gap-5 shadow-xl">
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
                <div className="absolute inset-0 rounded-full bg-[hsl(var(--accent))/0.3] pulse-ring scale-125" />
                <div className="w-28 h-28 rounded-full navy-gradient flex items-center justify-center shadow-2xl border-4 border-white/10">
                  <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5">
                    <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5z"/>
                    <path d="M20.84 14a8 8 0 0 1-15.68 0"/>
                    <line x1="12" y1="22" x2="12" y2="18"/>
                  </svg>
                </div>
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-lg">AI 면접관</p>
                <p className="text-white/50 text-sm">Kim AI · 인사담당 매니저</p>
              </div>
            </div>
            <div className="z-10 flex items-center gap-1 h-10">
              {Array.from({ length: 24 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-[hsl(var(--accent))/0.5]"
                  style={{
                    height: `${20 + Math.sin(i * 0.6) * 15}px`,
                    animation: `recordingBlink ${0.8 + (i % 3) * 0.2}s ease-in-out ${i * 0.05}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[hsl(222,47%,15%)] p-6 shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center">
                <span className="text-white text-xs font-bold">Q</span>
              </div>
              <span className="text-white/60 text-sm">질문 {questionIndex + 1}</span>
            </div>
            <p key={questionIndex} className="text-white text-lg leading-relaxed font-medium screen-enter">
              {busy ? "다음 질문을 생성하는 중입니다..." : question}
            </p>
          </div>

          {/* 답변 메모 — 입력하면 AI 꼬리질문에 반영된다 */}
          <div className="rounded-2xl border border-white/10 bg-[hsl(222,47%,15%)] p-4 shadow-lg">
            <label className="text-white/60 text-sm mb-2 block">
              내 답변 메모{" "}
              <span className="text-white/30">(입력하면 다음 질문에 반영됩니다)</span>
            </label>
            <textarea
              value={answer}
              onChange={(e) => onAnswerChange(e.target.value)}
              rows={3}
              placeholder="답변 요지를 적어 주세요. AI가 이어서 더 깊은 질문을 만듭니다."
              className="w-full bg-[hsl(222,47%,10%)] border border-white/10 rounded-xl p-3 text-white text-sm resize-none focus:outline-none focus:border-[hsl(var(--accent))]"
            />
          </div>
        </div>

        {/* Right 30% */}
        <div className="flex-[3] flex flex-col p-4 pl-0 gap-4">
          <div
            className="rounded-2xl overflow-hidden border border-white/10 shadow-xl relative"
            style={{ aspectRatio: "4/3" }}
          >
            <div className="webcam-placeholder w-full h-full">
              <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
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
          {abandoned ? "면접 중단" : "면접 결과 리포트"}
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
        {abandoned ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center screen-enter">
            <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center mb-6 shadow-md">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ea580c" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-[hsl(var(--primary))] mb-3">면접이 중도 포기되었습니다</h2>
            <p className="text-muted-foreground max-w-sm mb-2 leading-relaxed">
              모든 질문을 완료하지 않아 결과를 분석할 수 없습니다.
            </p>
            <p className="text-muted-foreground text-sm max-w-sm mb-8">
              정확한 피드백을 받으려면 면접을 끝까지 진행해 주세요.
            </p>
            <div className="flex gap-3">
              <button
                data-testid="button-go-home"
                onClick={onRestart}
                className="px-6 py-3 border border-[hsl(var(--border))] text-[hsl(var(--primary))] font-semibold rounded-xl hover:bg-[hsl(var(--secondary))] transition-colors"
              >
                처음으로
              </button>
              <button
                data-testid="button-retry-after-abandon"
                onClick={onRestart}
                className="px-6 py-3 navy-gradient text-white font-bold rounded-xl shadow hover:shadow-md hover:scale-105 active:scale-100 transition-all duration-150"
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── HISTORY ─────────────────────────── */

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
              <div key={r.id} className="navy-card rounded-2xl p-5 flex items-center gap-5">
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

  const handleSubmit = async () => {
    if (!email || !password) { setError("이메일과 비밀번호를 입력해 주세요."); return; }
    if (tab === "signup" && !name) { setError("이름을 입력해 주세요."); return; }
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
