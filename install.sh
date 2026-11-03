#!/usr/bin/env bash
# Dusk Cellar 설치 (리눅스·맥). git·시스템 Node 없이도 돼요.
#   curl -fsSL https://raw.githubusercontent.com/Pyser08/Dusk-Cellar/main/install.sh | bash
#   bash install.sh [리스 폴더] [setup.cjs 옵션...]
# 리스 폴더에 bin/node가 있으면(휴대용 배포본) 그걸 쓰고 '이름_cellar' 실행 파일을 만들어요.
set -e
REPO="${DUSK_CELLAR_REPO:-https://github.com/Pyser08/Dusk-Cellar}"
REF="${DUSK_CELLAR_REF:-main}"
ARCHIVE="${DUSK_CELLAR_ARCHIVE:-$REPO/archive/refs/heads/$REF.tar.gz}"
say() { printf '\n%s\n' "$*"; }
die() { printf '\n[실패] %s\n' "$*" >&2; exit 1; }

# 파이프(curl | bash)로 실행되면 질문에 답할 수 있게 터미널을 다시 연결
if [ ! -t 0 ]; then { exec </dev/tty; } 2>/dev/null || true; fi

DIR="$PWD"
if [ -n "$1" ] && [ -d "$1" ]; then DIR="$(cd "$1" && pwd)"; shift; fi
cd "$DIR"
say "설치 위치: $DIR"

# Node: 리스에 들어 있는 bin/node 우선, 없으면 시스템 Node(22 이상)
NODE=""
if [ -x ./bin/node ]; then NODE="$DIR/bin/node"
elif command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] 2>/dev/null || die "Node.js가 낮아요($(node -v)). 22 이상이 필요해요 (또는 bin/node가 들어 있는 휴대용 리스 폴더에서 실행하세요)"
  NODE="$(command -v node)"
else die "Node.js를 못 찾았어요. 리스 폴더(bin/node가 있는 곳)에서 실행하거나 Node.js 22 이상을 설치해 주세요 (https://nodejs.org)"; fi

if [ -d Dusk-Cellar/.git ]; then
  say "이미 설치돼 있어서 최신으로 받아요"
  git -C Dusk-Cellar pull --ff-only || die "업데이트에 실패했어요(수정한 파일이 있을 수 있어요)"
elif command -v git >/dev/null 2>&1 && [ ! -e Dusk-Cellar ]; then
  git clone "$REPO" Dusk-Cellar || die "내려받기에 실패했어요"
else
  # git이 없거나 git 없이 설치했던 폴더: 압축 파일을 받아 풀어요(dusk-data는 그대로 둬요)
  command -v curl >/dev/null 2>&1 || die "curl이 없어요"
  command -v tar  >/dev/null 2>&1 || die "tar가 없어요"
  say "내려받는 중… ($ARCHIVE)"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "$ARCHIVE" -o "$TMP/c.tgz" || die "내려받기에 실패했어요"
  mkdir "$TMP/x" && tar -xzf "$TMP/c.tgz" -C "$TMP/x" || die "압축을 풀지 못했어요"
  SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -f "$SRC/setup.cjs" ] || die "받은 파일이 올바르지 않아요"
  mkdir -p Dusk-Cellar
  (cd "$SRC" && tar -cf - .) | (cd Dusk-Cellar && tar -xf -)
fi
cd Dusk-Cellar
"$NODE" setup.cjs "$@"
