#!/usr/bin/env bash
# B′ 한 번 실행: 리뷰 표 비우기 → 지연 프록시 → BE(old|after) → 연결 풀 수집기 → k6 → 정리.
# 사용: run-b.sh <old|after> <지연 ms> <isolated|contention> <결과 폴더 이름>
set -uo pipefail
VER="$1"; DELAY="$2"; MODE="$3"; NAME="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/결과/$NAME"; mkdir -p "$OUT"
ROOT=/c/Users/SSAFY/Downloads/workspace

kill_port() {
  powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -Confirm:\$false }" >/dev/null 2>&1
}
kill_port 8080; kill_port 13999

MSYS_NO_PATHCONV=1 docker exec fit-local-postgres-1 psql -U postgres -d fit_measure_b -q \
  -c "TRUNCATE review_photos, review_reason_tags, review_reports, reviews RESTART IDENTITY"

node "$HERE/delay-proxy.js" 13999 127.0.0.1:13900 "$DELAY" > "$OUT/proxy.log" 2>&1 &
bash "$HERE/run-be.sh" "$VER" http://127.0.0.1:13999 > "$OUT/be.log" 2>&1 &

for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:8081/actuator/health/readiness >/dev/null 2>&1 && break
  sleep 1
done
curl -sf http://127.0.0.1:8081/actuator/health/readiness >/dev/null || { echo "BE not ready"; kill_port 8080; kill_port 13999; exit 1; }

if [ "$MODE" = isolated ]; then
  ENVS=(-e EDIT_VUS=1 -e READ_VUS=0 -e "ITERS=${ITERS:-10}" -e PER_PATCH=1)
else
  ENVS=(-e EDIT_VUS=20 -e READ_VUS=20 -e ITERS=0 -e DURATION=60s)
fi

STOP="$OUT/.stop"; rm -f "$STOP"
python -I "$HERE/poll-hikari.py" "$OUT/hikari.json" "$STOP" &
POLL=$!

DEMO_EMAIL=$(grep -E '^AUTH_DEMO_EMAIL=' "$ROOT/S15P31A302/be/.env" | cut -d= -f2-)
DEMO_PASSWORD=$(grep -E '^AUTH_DEMO_PASSWORD=' "$ROOT/S15P31A302/be/.env" | cut -d= -f2-)
export DEMO_EMAIL DEMO_PASSWORD
MSYS_NO_PATHCONV=1 docker run --rm --network fit-local_default \
  -v "$(cygpath -w "$HERE"):/scripts:ro" -v "$(cygpath -w "$OUT"):/out" \
  -e DEMO_EMAIL -e DEMO_PASSWORD "${ENVS[@]}" \
  grafana/k6:latest run --quiet --summary-export /out/k6-summary.json /scripts/b-photo.js > "$OUT/k6.txt" 2>&1
echo "k6 exit=$?" >> "$OUT/k6.txt"

touch "$STOP"; wait "$POLL"; rm -f "$STOP"
kill_port 8080; kill_port 13999
echo "done $NAME"
