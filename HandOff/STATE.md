# Dusk Cellar — 진행 상황

플러그인 [Dusk Atelier](https://github.com/Pyser08/Dusk-Atelier)의 백그라운드 서버. 작업 규칙은 Dusk-Atelier의 `HandOff/README.md`를 따른다(버전·브랜치·main은 사용자 지시가 있을 때만, 버그는 실패 시험 먼저, 끝낼 때 시험 통과 확인, 이 파일 갱신).

## 원칙
- 선택 기능: Cellar가 없어도 플러그인은 지금처럼 동작해야 한다.
- 리스 프로세스에 섞지 않는다. 실행기(`cellar-start.cjs`)가 리스와 Cellar를 따로 켠다.
- 리스 파일·데이터는 읽지도 고치지도 않는다. Cellar 데이터는 `dusk-data/`에만.
- Node 기본 모듈만(설치 불필요). Node 22 이상.
- 기본 127.0.0.1만. loopback 요청은 토큰 없이(리스 프록시가 리스 암호로 보호), 그 외 또는 `--require-token`이면 토큰(`dusk-data/token.txt`) 필수.

## 파일
- `setup.cjs` — 한 번 설치: 리스 찾기(위쪽 4단계 → 옆 폴더 4단계, node_modules 제외) → 빌드(pnpm-lock+pnpm이면 pnpm, 아니면 npm; build 스크립트 없으면 install만) → pm2 목록·지울 것 고르기(리스 직접 실행·옛 실행기 '추천', 비대화면 지우지 않음, `--yes`면 추천만) → `pm2 start cellar-start.cjs --name risu --cwd <리스> -- --risu …` + `pm2 save` → 부팅 자동 실행(`startupPlan`: 리눅스 systemd·맥 launchd를 sudo env PATH=… pm2 startup으로, root는 바로, 윈도우·Termux는 안내만, `--no-startup`) → health 확인. 순수 함수는 module.exports로 시험.
- `cellar-start.cjs` — 실행기 + 서버(같은 파일 `--role-server`). 리스 종료 → Cellar 종료·같은 코드, Cellar만 죽으면 최대 5번 재시작(1·2·4·8·16초), 포트 사용 중(78)이면 리스만.
- `tests/` — `node --test tests/*.js tests/*.mjs` (12개).

## 진행
- [x] 실행 구조, 설치기, README (2026-11-03, b48c204)
- [x] 실제 설치 시험: RisuBard(우분투 서버, ~/RisuBard/Dusk-Cellar, pm2) 5/5 통과, health 응답 확인 (2026-11-03). RisuBard 시작 파일 = server/node/server.cjs 자동 찾기 성공
- [ ] 윈도우·맥·Termux, 원본 RisuAI 설치 시험
- [x] 플러그인 연결(2026-11-03): 플러그인이 nativeFetch로 http://127.0.0.1:6011/cellar/health 확인 → 리스 노드 서버의 /proxy2(리스 암호 필요)가 대신 보내므로 loopback 요청은 토큰 없이 허용, `--require-token`이면 토큰 필수. Atelier `src/data/cellar.js`·설정 '서버' 카드. 미확인: 실제 RisuBard에서 '연결됨'
- [ ] 1단계: 기억 백업 + 화면에 필요한 조각만 돌려주기, 속도 측정
- [ ] (효과 있으면) 분석·임베딩 서버 실행
