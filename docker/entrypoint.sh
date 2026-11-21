#!/bin/sh
# 환경변수를 cellar-start.cjs --role-server 옵션으로 바꿔서 실행한다. 뒤에 붙인 옵션(-…)은 그대로 넘긴다.
#   CELLAR_PORT          Cellar 포트(기본 6011)
#   CELLAR_HOST          듣는 주소(기본 127.0.0.1 — 리스 컨테이너와 네트워크를 같이 쓸 때 그대로 둔다)
#   CELLAR_SAVE_DIR      리스 세이브 폴더(기본 /save, 비우면 백업·플러그인·에셋 기능 끔)
#   CELLAR_RISU_PORT     리스 서버 포트(PocketRisu 6001, RisuBard 7777 · 비우면 Cellar 기본값)
#   CELLAR_KEEP          백업 보관 개수(기본 5)
#   CELLAR_HOST_DIR      msgpackr·fflate를 찾을 폴더(옛 형식 database.bin을 풀 때, 기본 /opt/risu-host)
#   CELLAR_REQUIRE_TOKEN 1이면 loopback 요청에도 토큰 요구
set -e
# 첫 인자가 옵션(-…)이 아니면 그 명령을 그대로 실행한다(docker run … sh, node -e … 등)
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then exec "$@"; fi
exec node /app/cellar-start.cjs --role-server \
  --dusk-host "${CELLAR_HOST:-127.0.0.1}" \
  --dusk-port "${CELLAR_PORT:-6011}" \
  --data-dir /data \
  --save-dir "${CELLAR_SAVE_DIR-/save}" \
  --keep "${CELLAR_KEEP:-5}" \
  ${CELLAR_RISU_PORT:+--risu-port "$CELLAR_RISU_PORT"} \
  --host-dir "${CELLAR_HOST_DIR:-/opt/risu-host}" \
  ${CELLAR_REQUIRE_TOKEN:+--require-token} \
  "$@"
