#!/usr/bin/env bash
# 맥: 이 파일을 리스 폴더에 넣고 더블클릭(처음 한 번은 우클릭 → 열기). 터미널이 열리고 설치가 진행돼요.
cd "$(dirname "$0")" || exit 1
curl -fsSL https://raw.githubusercontent.com/Pyser08/Dusk-Cellar/main/install.sh -o .dusk-install.sh || { echo "내려받기에 실패했어요"; read -r -p "엔터를 누르면 닫혀요"; exit 1; }
bash .dusk-install.sh "$PWD"
rc=$?; rm -f .dusk-install.sh
read -r -p "끝났어요. 엔터를 누르면 닫혀요" _
exit $rc
