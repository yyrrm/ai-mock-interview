// poseAnalyzer.ts — 브라우저에서 MediaPipe 로 관절 좌표를 추출해 서버로 스트리밍한다.
//
// 접근 A: 무거운 영상 처리는 브라우저가 하고, 서버에는 "관절 좌표"만 보낸다.
// - 웹캠 영상 → PoseLandmarker(고fps) → 33개 랜드마크
// - 프레임을 버퍼에 모아 ~300ms 마다 배치로 POST (페이로드 작음)
// - 서버(PoseEvaluator)가 매긴 실제 점수를 onScore 로 전달
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const SEND_INTERVAL_MS = 300;

type Frame = { t: number; landmarks: number[][] };

export type PoseAnalyzerHandle = {
  /** 분석을 멈추고 서버에 종료 신호 → 세션 평균 점수(없으면 null) 반환 */
  stop: () => Promise<number | null>;
};

export async function startPoseAnalyzer(
  video: HTMLVideoElement,
  sessionId: string,
  onScore: (score: number, feedback?: string) => void
): Promise<PoseAnalyzerHandle> {
  const vision = await FilesetResolver.forVisionTasks(WASM);

  // GPU 우선, 실패 시 CPU 폴백
  let landmarker: PoseLandmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  }

  let running = true;
  let buffer: Frame[] = [];
  let lastVideoTime = -1;

  // 매 프레임: 랜드마크 추출 → 버퍼에 적재
  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = performance.now();
      try {
        const res = landmarker.detectForVideo(video, ts);
        const lms = res.landmarks && res.landmarks[0];
        if (lms && lms.length >= 25) {
          // 셀피 영상이라 좌우가 뒤집혀 있음 → x 를 1-x 로 미러 보정
          // (서버 PoseEvaluator 가 데스크톱과 동일한 좌/우 기준을 갖게 함)
          const landmarks = lms.map((p) => [1 - p.x, p.y, p.z ?? 0]);
          buffer.push({ t: ts, landmarks });
        }
      } catch {
        /* 일시적 추론 오류는 다음 프레임에서 복구 */
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 주기적으로 모아둔 프레임을 서버로 전송
  const sendTimer = window.setInterval(async () => {
    if (!running || buffer.length === 0) return;
    const frames = buffer;
    buffer = [];
    try {
      const res = await fetch("/api/analyze/pose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, frames }),
      });
      const data = await res.json();
      if (data.ok && data.detected) onScore(data.score, data.feedback);
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
        const res = await fetch("/api/analyze/pose/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        const data = await res.json();
        return data.ok && typeof data.score === "number" ? data.score : null;
      } catch {
        return null;
      }
    },
  };
}
