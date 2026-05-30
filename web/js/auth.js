/* =========================================================
   auth.js - 회원가입 / 로그인 (localStorage 시뮬레이션)
   * 나중에 FastAPI + DB로 교체할 부분은 이 파일만 바꾸면 됨
   * 비밀번호는 데모용이라 평문 저장 (실서비스에선 서버에서 해시 처리)
   ========================================================= */

/* 가입된 사용자 목록 */
function getUsers() {
  return loadJSON(KEYS.users, []);
}
function saveUsers(users) {
  saveJSON(KEYS.users, users);
}

/* ---------- 회원가입 ---------- */
function signup({ username, password, password2, nickname }) {
  username = (username || "").trim();
  nickname = (nickname || "").trim();

  if (!username || !password || !nickname) {
    return { ok: false, msg: "모든 항목을 입력해주세요." };
  }
  if (username.length < 4) {
    return { ok: false, msg: "아이디는 4자 이상이어야 합니다." };
  }
  if (password.length < 4) {
    return { ok: false, msg: "비밀번호는 4자 이상이어야 합니다." };
  }
  if (password !== password2) {
    return { ok: false, msg: "비밀번호가 일치하지 않습니다." };
  }

  const users = getUsers();
  if (users.some((u) => u.username === username)) {
    return { ok: false, msg: "이미 사용 중인 아이디입니다." };
  }
  if (users.some((u) => u.nickname === nickname)) {
    return { ok: false, msg: "이미 사용 중인 닉네임입니다." };
  }

  users.push({ username, password, nickname });
  saveUsers(users);
  return { ok: true };
}

/* ---------- 로그인 ---------- */
function login({ username, password }) {
  username = (username || "").trim();
  const users = getUsers();
  const found = users.find((u) => u.username === username);

  if (!found || found.password !== password) {
    return { ok: false, msg: "아이디 또는 비밀번호가 올바르지 않습니다." };
  }

  setSession({ username: found.username, nickname: found.nickname });
  return { ok: true };
}
