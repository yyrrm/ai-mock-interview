#!/usr/bin/env bash
# AI Mock Interview — 배포 스크립트 (리눅스 서버 전용)
#
# 사용법:  ~/ai-mock-interview/deploy.sh
# 동작:    git pull → 프론트엔드 빌드 → (Python 변경 시) 서버 reload
#
# 참고: web/server.py 가 dist 를 매 요청마다 디스크에서 직접 읽고
#       index.html 은 no-store 라서, UI(dist)만 바뀐 경우엔 서버 재시작이
#       필요 없다. Python 코드(.py)가 바뀐 경우에만 reload 한다.
set -euo pipefail

REPO="$HOME/ai-mock-interview"
SERVICE="ai-mock-interview.service"

cd "$REPO"

echo "==> [1/4] 최신 코드 받기 (git pull)"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

# 이번 pull 로 Python 파일이 바뀌었는지 검사 (서버 reload 필요 여부 판단)
PY_CHANGED=0
if [ "$BEFORE" != "$AFTER" ]; then
  if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '\.py$'; then
    PY_CHANGED=1
  fi
fi

echo "==> [2/4] 프론트엔드 빌드"
cd "$REPO/frontend"
npm install --silent
npm run build
cd "$REPO"

echo "==> [3/4] 빌드 결과물 커밋 (변경 있을 때만)"
if [ -n "$(git status --porcelain -- frontend/dist)" ]; then
  git add frontend/dist
  git commit -m "build: UI dist 갱신" || true
  echo "    dist 변경 커밋됨 — 다른 PC에 반영하려면 'git push' 하세요."
else
  echo "    dist 변경 없음 (커밋 생략)."
fi

echo "==> [4/4] 서버 reload"
if [ "$PY_CHANGED" -eq 1 ]; then
  if sudo -n systemctl restart "$SERVICE" 2>/dev/null; then
    echo "    Python 변경 감지 → systemctl restart 완료."
  else
    # sudo 불가 시: gunicorn 마스터에 HUP → graceful reload
    PID="$(pgrep -f 'gunicorn .*server:app' | head -1 || true)"
    if [ -n "$PID" ]; then
      kill -HUP "$PID"
      echo "    Python 변경 감지 → gunicorn(pid $PID) HUP reload 완료."
    else
      echo "    !! gunicorn 프로세스를 못 찾음. 'sudo systemctl restart $SERVICE' 를 수동 실행하세요."
      exit 1
    fi
  fi
else
  echo "    Python 변경 없음 → 재시작 불필요 (dist 는 즉시 반영됨)."
fi

echo "==> 완료. http://0.0.0.0:5500 에서 확인하세요."
