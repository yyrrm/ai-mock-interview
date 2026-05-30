/* =========================================================
   data.js - 면접 기록 데이터 (localStorage 시뮬레이션)
   * 나중에 FastAPI에서 면접 결과를 받아오도록 교체할 부분
   ========================================================= */

/* 전체 기록 (모든 사용자) */
function getAllRecords() {
  return loadJSON(KEYS.records, []);
}
function saveAllRecords(records) {
  saveJSON(KEYS.records, records);
}

/* 현재 로그인 사용자의 기록만 (최신순) */
function getMyRecords() {
  const s = getSession();
  if (!s) return [];
  return getAllRecords()
    .filter((r) => r.username === s.username)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* 단일 기록 조회 */
function getRecordById(id) {
  return getAllRecords().find((r) => r.id === id) || null;
}

/* 기록 저장 후 id 반환 */
function addRecord(record) {
  const records = getAllRecords();
  records.push(record);
  saveAllRecords(records);
  return record.id;
}

/* ---------- 가짜 면접 결과 생성 (데모용) ----------
   실제로는 분석 모듈(자세/시선/표정/음성)이 점수를 만들지만,
   지금은 껍데기라 랜덤 + 그럴듯한 피드백으로 채운다. */
function randBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

const FEEDBACK_POOL = {
  자세: {
    high: "자세가 안정적이고 흔들림이 적었습니다.",
    mid: "약간의 움직임이 감지되었습니다. 어깨를 펴고 고정해보세요.",
    low: "움직임이 많아 불안정해 보였습니다. 바른 자세를 유지해보세요.",
  },
  시선: {
    high: "카메라를 안정적으로 응시했습니다.",
    mid: "시선 처리가 다소 불안정합니다. 카메라와 더 눈을 맞춰보세요.",
    low: "시선 이탈이 잦았습니다. 정면 응시 연습이 필요합니다.",
  },
  표정: {
    high: "밝고 자연스러운 표정을 유지했습니다.",
    mid: "표정 변화가 다소 적었습니다. 부드러운 미소를 의식해보세요.",
    low: "긴장된 표정이 많았습니다. 답변 전 한 번 호흡을 가다듬어보세요.",
  },
  음성: {
    high: "발음이 또렷하고 전달력이 좋았습니다.",
    mid: "목소리 크기가 일정하지 않았습니다. 끝까지 또렷하게 말해보세요.",
    low: "음성이 작아 인식이 어려웠습니다. 더 크고 천천히 말해보세요.",
  },
};

function pickFeedback(cat, score) {
  const tier = score >= 80 ? "high" : score >= 60 ? "mid" : "low";
  return FEEDBACK_POOL[cat][tier];
}

const SAMPLE_QUESTIONS = [
  "간단히 자기소개 부탁드립니다.",
  "최근에 진행한 프로젝트에서 가장 어려웠던 점은 무엇이었나요?",
  "팀에서 갈등이 생겼을 때 어떻게 해결하나요?",
  "본인의 강점과 약점을 말씀해주세요.",
  "그 기술을 선택한 이유는 무엇인가요?",
];

function createMockResult() {
  const s = getSession();
  const pose = randBetween(55, 95);
  const gaze = randBetween(50, 95);
  const expr = randBetween(55, 95);
  const voice = randBetween(55, 95);
  const total = Math.round((pose + gaze + expr + voice) / 4);

  const id = "rec_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

  return {
    id,
    username: s ? s.username : "guest",
    date: new Date().toISOString(),
    scores: { 자세: pose, 시선: gaze, 표정: expr, 음성: voice, total },
    feedback: [
      { cat: "자세", text: pickFeedback("자세", pose) },
      { cat: "시선", text: pickFeedback("시선", gaze) },
      { cat: "표정", text: pickFeedback("표정", expr) },
      { cat: "음성", text: pickFeedback("음성", voice) },
    ],
    questions: SAMPLE_QUESTIONS.slice(0, randBetween(3, 5)),
  };
}
