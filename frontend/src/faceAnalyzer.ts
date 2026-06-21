// faceAnalyzer.ts — 브라우저에서 MediaPipe FaceLandmarker 로 표정·시선 신호를
// 추출해 서버로 스트리밍한다. (poseAnalyzer.ts 와 동일한 '접근 A')
//
// - 웹캠 영상 → FaceLandmarker(VIDEO) → 52개 블렌드셰이프 + 얼굴 랜드마크
// - 블렌드셰이프(표정 계수)와 머리 yaw(코·얼굴 외곽 랜드마크로 계산)를
//   ~300ms 마다 배치로 POST (페이로드 작음)
// - 서버(ExpressionEvaluator/GazeEvaluator)가 매긴 점수를 onScores 로 전달
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const SEND_INTERVAL_MS = 300;
const DETECT_INTERVAL_MS = 80; // 표정 추론은 ~12fps 로 제한 (자세 분석과 동시 구동 부하↓)

// MediaPipe Face Mesh 랜드마크 인덱스 (머리 yaw 근사용)
const NOSE_TIP = 1;
const FACE_LEFT = 234;
const FACE_RIGHT = 454;

type Frame = { t: number; blend: Record<string, number>; yaw: number };

export type FaceScores = { expression: number | null; gaze: number | null };
export type FaceSummary = {
  expression: number | null;
  gaze: number | null;
  expressionFeedback: string;
  gazeFeedback: string;
};

export type FaceAnalyzerHandle = {
  /** 분석을 멈추고 서버에 종료 신호 → 세션 평균 점수/피드백 반환 */
  stop: () => Promise<FaceSummary>;
};

export async function startFaceAnalyzer(
  video: HTMLVideoElement,
  sessionId: string,
  onScores: (scores: FaceScores) => void
): Promise<FaceAnalyzerHandle> {
  const vision = await FilesetResolver.forVisionTasks(WASM);

  // GPU 우선, 실패 시 CPU 폴백
  let landmarker: FaceLandmarker;
  const opts = {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" as const },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };
  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, opts);
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(vision, {
      ...opts,
      baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
    });
  }

  let running = true;
  let buffer: Frame[] = [];
  let lastVideoTime = -1;
  let lastDetectTs = 0;

  function loop() {
    if (!running) return;
    const now = performance.now();
    if (
      video.readyState >= 2 &&
      video.videoWidth &&
      video.currentTime !== lastVideoTime &&
      now - lastDetectTs >= DETECT_INTERVAL_MS
    ) {
      lastVideoTime = video.currentTime;
      lastDetectTs = now;
      try {
        const res = landmarker.detectForVideo(video, now);
        const cats = res.faceBlendshapes && res.faceBlendshapes[0]?.categories;
        const lms = res.faceLandmarks && res.faceLandmarks[0];
        if (cats && cats.length) {
          const blend: Record<string, number> = {};
          for (const c of cats) {
            if (c.categoryName) blend[c.categoryName] = c.score;
          }
          // 머리 yaw 근사: 코끝이 얼굴 좌우 외곽의 중앙에서 얼마나 벗어났나(-1~1)
          let yaw = 0;
          if (lms && lms.length > FACE_RIGHT) {
            const nose = lms[NOSE_TIP];
            const fl = lms[FACE_LEFT];
            const fr = lms[FACE_RIGHT];
            const width = Math.abs(fr.x - fl.x) || 1e-6;
            const center = (fl.x + fr.x) / 2;
            yaw = Math.max(-1, Math.min(1, ((nose.x - center) / width) * 2));
          }
          buffer.push({ t: now, blend, yaw });
        }
      } catch (e) {
        console.error("[faceAnalyzer] 추론 오류:", e);
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  const sendTimer = window.setInterval(async () => {
    if (!running || buffer.length === 0) return;
    const frames = buffer;
    buffer = [];
    try {
      const res = await fetch("/api/analyze/face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, frames }),
      });
      const data = await res.json();
      if (data.ok && data.detected) {
        onScores({ expression: data.expression ?? null, gaze: data.gaze ?? null });
      }
    } catch {
      /* 네트워크 일시 오류는 다음 주기에 자동 복구 */
    }
  }, SEND_INTERVAL_MS);

  return {
    async stop() {
      running = false;
      window.clearInterval(sendTimer);
      try {
        landmarker.close();
      } catch {
        /* ignore */
      }
      try {
        const res = await fetch("/api/analyze/face/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        const data = await res.json();
        return {
          expression: data.expression?.score ?? null,
          gaze: data.gaze?.score ?? null,
          expressionFeedback: data.expression?.feedback ?? "",
          gazeFeedback: data.gaze?.feedback ?? "",
        };
      } catch {
        return { expression: null, gaze: null, expressionFeedback: "", gazeFeedback: "" };
      }
    },
  };
}
