// voiceAnalyzer.ts — 브라우저에서 발화 지표를 모아 서버로 보내 점수를 받는다.
//
// 데스크톱은 WAV+Google STT 로 평가하지만, 웹에서는 추가 키/포맷 변환 없이
// 브라우저가 직접 계산한다:
//  - Web Audio API(AnalyserNode): 음량(dBFS)·침묵 구간·발화 길이
//  - Web Speech API(있을 때만, 주로 Chrome/Edge): 인식 텍스트·단어 수·신뢰도
// stop() 시 누적 지표를 /api/analyze/voice/end 로 보내 서버 루브릭으로 점수화.

const SAMPLE_INTERVAL_MS = 50; // 음량 샘플링 주기
const SILENCE_DB = -45; // 서버 audio_metrics 와 동일한 침묵 임계 (dBFS)
const MIN_SILENCE_FRAMES = Math.round(2000 / SAMPLE_INTERVAL_MS); // 2초 이상 침묵
const BASELINE_WINDOW_FRAMES = Math.round(5000 / SAMPLE_INTERVAL_MS); // 앞 5초 = 기준 음량

export type VoiceSummary = { score: number | null; feedback: string };

export type VoiceAnalyzerHandle = {
  /** 분석 종료 → 서버 점수/피드백 반환. fallbackText: STT 미지원 시 단어 수 대용(답변 메모) */
  stop: (opts?: { fallbackText?: string }) => Promise<VoiceSummary>;
};

type SpeechRecognitionish = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

export function startVoiceAnalyzer(stream: MediaStream): VoiceAnalyzerHandle {
  let running = true;
  const startedAt = performance.now();

  // ── Web Audio: 음량/침묵 ─────────────────────────────
  const dbFrames: number[] = [];
  let silenceSegments = 0;
  let silenceRun = 0;

  const AudioCtor: typeof AudioContext =
    window.AudioContext || (window as any).webkitAudioContext;
  let ctx: AudioContext | null = null;
  let sampleTimer = 0;
  // ArrayBuffer 백킹을 명시해 getFloatTimeDomainData 의 타입(Float32Array<ArrayBuffer>)과 맞춘다.
  let buf: Float32Array<ArrayBuffer> | null = null;
  let analyser: AnalyserNode | null = null;

  try {
    ctx = new AudioCtor();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

    sampleTimer = window.setInterval(() => {
      if (!running || !analyser || !buf) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = 20 * Math.log10(rms + 1e-12); // float 풀스케일(1.0)=0dBFS → 서버와 동일 기준
      dbFrames.push(db);

      if (db < SILENCE_DB) {
        silenceRun++;
      } else {
        if (silenceRun >= MIN_SILENCE_FRAMES) silenceSegments++;
        silenceRun = 0;
      }
    }, SAMPLE_INTERVAL_MS);
  } catch {
    /* Web Audio 사용 불가 → 음량 지표 없이 진행 */
  }

  // ── Web Speech: 텍스트/단어수/신뢰도 (있을 때만) ─────────
  let transcript = "";
  const confidences: number[] = [];
  const SR: (new () => SpeechRecognitionish) | undefined =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let recog: SpeechRecognitionish | null = null;

  if (SR) {
    try {
      recog = new SR();
      recog.lang = "ko-KR";
      recog.continuous = true;
      recog.interimResults = false;
      recog.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            transcript += " " + (r[0]?.transcript || "");
            const c = r[0]?.confidence;
            if (typeof c === "number" && c > 0) confidences.push(c);
          }
        }
      };
      recog.onerror = () => {};
      // Chrome 은 일정 침묵 후 자동 종료 → 면접 동안 계속 재시작
      recog.onend = () => {
        if (running && recog) {
          try {
            recog.start();
          } catch {
            /* 이미 시작됨 등은 무시 */
          }
        }
      };
      recog.start();
    } catch {
      recog = null;
    }
  }

  return {
    async stop(opts) {
      running = false;
      if (sampleTimer) window.clearInterval(sampleTimer);
      if (silenceRun >= MIN_SILENCE_FRAMES) silenceSegments++; // 마지막 구간 반영
      if (recog) {
        try {
          recog.onend = null;
          recog.stop();
        } catch {
          /* ignore */
        }
      }
      if (ctx) ctx.close().catch(() => {});

      const durationSec = (performance.now() - startedAt) / 1000;

      // ── 음량 통계 ──
      let meanDb = -60;
      let stdDb = 0;
      let baselineDb: number | undefined;
      if (dbFrames.length) {
        meanDb = dbFrames.reduce((a, b) => a + b, 0) / dbFrames.length;
        const variance =
          dbFrames.reduce((a, b) => a + (b - meanDb) * (b - meanDb), 0) / dbFrames.length;
        stdDb = Math.sqrt(variance);
        const head = dbFrames.slice(0, Math.min(BASELINE_WINDOW_FRAMES, dbFrames.length));
        baselineDb = head.reduce((a, b) => a + b, 0) / head.length;
      }

      // ── 단어 수: STT 우선, 없으면 답변 메모(fallbackText) ──
      const sttWords = transcript.trim().split(/\s+/).filter(Boolean).length;
      const fallbackWords = (opts?.fallbackText || "").trim().split(/\s+/).filter(Boolean).length;
      const wordCount = sttWords > 0 ? sttWords : fallbackWords;
      const sttConfidence =
        confidences.length > 0
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : undefined;

      // 음량 데이터도 없고 길이도 짧으면 평가 불가 → 서버가 score:null 로 응답
      try {
        const res = await fetch("/api/analyze/voice/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_sec: durationSec,
            mean_db: meanDb,
            std_db: stdDb,
            silence_segments: silenceSegments,
            baseline_db: baselineDb,
            word_count: wordCount,
            stt_confidence: sttConfidence,
          }),
        });
        const data = await res.json();
        return {
          score: typeof data.score === "number" ? data.score : null,
          feedback: data.feedback || "",
        };
      } catch {
        return { score: null, feedback: "" };
      }
    },
  };
}
