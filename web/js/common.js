/* =========================================================
   common.js - 공통 유틸 / 헤더 / 로그인 가드
   localStorage 기반 (나중에 FastAPI 호출로 교체)
   ========================================================= */

const KEYS = {
  users: "ai_interview_users",
  session: "ai_interview_session",
  records: "ai_interview_records",
};

/* ---------- localStorage 헬퍼 ---------- */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ---------- 세션(로그인 상태) ---------- */
function getSession() {
  return loadJSON(KEYS.session, null);
}
function setSession(user) {
  saveJSON(KEYS.session, user);
}
function clearSession() {
  localStorage.removeItem(KEYS.session);
}
function logout() {
  clearSession();
  location.href = "index.html";
}

/* 로그인 안 했으면 로그인 페이지로 보냄 (보호 페이지에서 호출) */
function requireLogin() {
  const s = getSession();
  if (!s) {
    location.href = "login.html";
    return null;
  }
  return s;
}

/* ---------- 점수 → 색상 클래스 ---------- */
function scoreClass(score) {
  if (score >= 80) return "s-high";
  if (score >= 60) return "s-mid";
  return "s-low";
}

/* ---------- 날짜 포맷 ---------- */
function formatDate(iso) {
  const d = new Date(iso);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}.${mm}.${dd} ${hh}:${mi}`;
}

/* ---------- 헤더 렌더 ---------- */
function renderHeader() {
  const el = document.getElementById("appHeader");
  if (!el) return;
  const s = getSession();

  let right;
  if (s) {
    right = `
      <nav class="nav">
        <a href="dashboard.html">마이페이지</a>
        <a href="history.html">면접 기록</a>
        <span class="nick">${escapeHtml(s.nickname)}님</span>
        <a href="#" onclick="logout();return false;">로그아웃</a>
      </nav>`;
  } else {
    right = `
      <nav class="nav">
        <a href="login.html">로그인</a>
        <a class="btn btn-primary" href="signup.html">시작하기</a>
      </nav>`;
  }

  el.className = "app-header";
  el.innerHTML = `
    <div class="inner">
      <a class="logo" href="${s ? "dashboard.html" : "index.html"}">
        <span class="mark">AI</span> 모의면접
      </a>
      ${right}
    </div>`;
}

/* ---------- 토스트 알림 (alert 대체) ---------- */
function toast(msg, icon = "✓") {
  let wrap = document.getElementById("toastWrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toastWrap";
    document.body.appendChild(wrap);
  }
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${icon}</span><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

/* ---------- 숫자 카운트업 애니메이션 ---------- */
function animateCount(el, target, suffix = "", dur = 900) {
  if (!el) return;
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = Math.round(target * eased) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- XSS 방지용 간단 이스케이프 ---------- */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* 페이지 로드 시 헤더 자동 렌더 */
document.addEventListener("DOMContentLoaded", renderHeader);
