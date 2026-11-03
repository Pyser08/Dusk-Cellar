#!/usr/bin/env bash
# Dusk Cellar 설치 (리눅스·맥). 리스 폴더에서 실행하거나, 폴더를 인자로 넘기세요.
#   curl -fsSL https://raw.githubusercontent.com/Pyser08/Dusk-Cellar/main/install.sh | bash
#   bash install.sh [리스 폴더] [setup.cjs 옵션...]
set -e
REPO="${DUSK_CELLAR_REPO:-https://github.com/Pyser08/Dusk-Cellar}"
say() { printf '\n%s\n' "$*"; }
die() { printf '\n[실패] %s\n' "$*" >&2; exit 1; }

# 파이프(curl | bash)로 실행되면 질문에 답할 수 있게 터미널을 다시 연결
if [ ! -t 0 ]; then { exec </dev/tty; } 2>/dev/null || true; fi

command -v git  >/dev/null 2>&1 || die "git이 없어요. 먼저 설치해 주세요 (리눅스: sudo apt install git / 맥: xcode-select --install)"
command -v node >/dev/null 2>&1 || die "Node.js가 없어요. 22 이상을 설치해 주세요 (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] 2>/dev/null || die "Node.js가 낮아요($(node -v)). 22 이상이 필요해요"

DIR="$PWD"
if [ -n "$1" ] && [ -d "$1" ]; then DIR="$(cd "$1" && pwd)"; shift; fi
cd "$DIR"
say "설치 위치: $DIR"
[ -d Dusk-Cellar/.git ] || [ -f server/node/server.cjs ] || [ -d ../server/node ] || say "※ 여기에 리스(server/node/server.cjs)가 안 보여요. 리스 폴더에서 실행했는지 확인해 주세요. 계속은 해요."

if [ -d Dusk-Cellar/.git ]; then
  say "이미 설치돼 있어서 최신으로 받아요"
  git -C Dusk-Cellar pull --ff-only || die "업데이트에 실패했어요(수정한 파일이 있을 수 있어요)"
else
  [ -e Dusk-Cellar ] && die "Dusk-Cellar 폴더가 이미 있는데 git 저장소가 아니에요. 옮기거나 지우고 다시 실행해 주세요"
  git clone "$REPO" Dusk-Cellar || die "내려받기에 실패했어요"
fi
cd Dusk-Cellar
node setup.cjs "$@"
