# Dusk Cellar — 진행 상황

플러그인 [Dusk Atelier](https://github.com/Pyser08/Dusk-Atelier)의 백그라운드 서버. 작업 규칙은 Dusk-Atelier의 `HandOff/README.md`를 따른다(버전·브랜치·main은 사용자 지시가 있을 때만, 버그는 실패 시험 먼저, 끝낼 때 시험 통과 확인, 이 파일 갱신).

- 작업 브랜치는 Atelier main의 `HandOff/README.md` '현재 작업 브랜치' 표가 기준이다. 브랜치가 바뀌면 그 표를 고친다.

## 원칙
- 선택 기능: Cellar가 없어도 플러그인은 지금처럼 동작해야 한다.
- 리스 프로세스에 섞지 않는다. 실행기(`cellar-start.cjs`)가 리스와 Cellar를 따로 켠다.
- 리스 파일·데이터는 읽지도 고치지도 않는다. Cellar 데이터는 `dusk-data/`에만.
- 서버 기능은 항상 순정 호스트(패치 안 한 RisuBard·PocketRisu·리스AI)를 기준으로 만든다. 호스트 패치에 기대는 기능은 만들지 않는다(사용자 결정 2026-11-03).
- Node 기본 모듈만(설치 불필요). Node 22 이상.
- 기본 127.0.0.1만. loopback 요청은 토큰 없이(리스 프록시가 리스 암호로 보호), 그 외 또는 `--require-token`이면 토큰(`dusk-data/token.txt`) 필수.

## 파일
- `setup.cjs` — 한 번 설치: 리스 찾기(위쪽 4단계 → 옆 폴더 4단계, node_modules 제외) → 빌드(pnpm-lock+pnpm이면 pnpm, 아니면 npm; build 스크립트 없으면 install만) → pm2 목록·지울 것 고르기(리스 직접 실행·옛 실행기 '추천', 비대화면 지우지 않음, `--yes`면 추천만) → `pm2 start cellar-start.cjs --name risu --cwd <리스> -- --risu …` + `pm2 save` → 부팅 자동 실행(`startupPlan`: 리눅스 systemd·맥 launchd를 sudo env PATH=… pm2 startup으로, root는 바로, 윈도우·Termux는 안내만, `--no-startup`) → health 확인. 순수 함수는 module.exports로 시험.
- `cellar-start.cjs` — 실행기 + 서버(같은 파일 `--role-server`). 리스 종료 → Cellar 종료·같은 코드, Cellar만 죽으면 최대 5번 재시작(1·2·4·8·16초), 포트 사용 중(78)이면 리스만.
- `store.cjs` — 기억 저장소(키-값 파일 저장, rev·baseRev 충돌 검사, opId 재전송 무시, 일별 스냅샷 7일). `cellar-start.cjs`의 `/cellar/mem*` 주소가 사용.
- `backup.cjs` — 세이브 백업·복원(바뀐 파일만 복사, 나머지는 직전 백업과 하드링크, 리스 파일과는 링크 안 함). 복원은 실행기 `doRestore`가 IPC 메시지(type restore)로 받아 리스·Cellar를 멈추고 '복원 전 자동' 백업 후 동기화하고 다시 켠다.
- `plugins.cjs` — 플러그인 코드 수정(RisuBard만). 호스트 구분(`detectHost`), list·get·apply. `/cellar/plugins`가 사용(아래 '플러그인 수정').
- `tests/` — `node --test tests/*.js tests/*.mjs` (57개). `tests/helpers/fakerisubard.cjs` = RisuBard 세이브 폴더 흉내 + 가짜 RisuBard 서버(로그인·세션·외부 변경 검토).

## 진행
- [x] 실행 구조, 설치기, README (2026-11-03, b48c204)
- [x] 실제 설치 시험: RisuBard(우분투 서버, ~/RisuBard/Dusk-Cellar, pm2) 5/5 통과, health 응답 확인 (2026-11-03). RisuBard 시작 파일 = server/node/server.cjs 자동 찾기 성공
- [ ] 윈도우·맥·Termux, 원본 RisuAI 설치 시험
- [x] 플러그인 연결(2026-11-03): 플러그인이 nativeFetch로 http://127.0.0.1:6011/cellar/health 확인 → 리스 노드 서버의 /proxy2(리스 암호 필요)가 대신 보내므로 loopback 요청은 토큰 없이 허용, `--require-token`이면 토큰 필수. Atelier `src/data/cellar.js`·설정 '서버' 카드. 실제 RisuBard(Oracle VM, 외부 접속)에서 '연결됨' 확인(2026-11-03)
- [x] 1단계(feat/0.1.0): 서버 쪽 기억 저장소 API (2026-11-03). 결정(사용자): 서버가 감지되면 기억은 서버에만 저장, 끊기면 플러그인이 임시 대기열에 쌓았다가 다시 연결되면 올림. 서버 단독으로는 시험 24개 통과.
- [ ] 1단계 플러그인 쪽(Atelier): 서버 감지 → 저장소 어댑터(`memorystore3.js`의 get/set/rm 18~20줄, `dusk.mem.v3.f.*`만), 끊김 대기열(변경분만·opId·상한), 처음 연결 시 로컬 기억 올리기(로컬 원본은 남김), 연속 2~3회 실패해야 끊김으로 판단, 충돌은 기록 합치기+최신 시각 우선. 설정·인덱스 분리 필요 여부 확인(인덱스에 settings가 섞여 있음). 작업 브랜치 미정.
- [x] 플러그인 쪽 기억 저장(Atelier feat/1.8.3, `src/data/memoryremote.js`) (2026-11-03)
- [x] 2단계 백업·복원(`/cellar/backup`, 2026-11-03). 조사: 원본 RisuAI는 `save/`에 hex 이름 파일, RisuBard(PocketRisu 기반)는 `save/kv/manifest.json`+`save/kv/objects/` → 공통은 `<리스>/save`. 압축 대신 증분 스냅샷(하드링크). 시험 파일 2만 개·1GB: 백업 4.8초→3.0초(증분), 복원 1.0초 vs tar.gz 34.6초/풀기 7.2초.
- [x] 저장 형식 조사 보강(2026-11-03): PocketRisu는 `save/risuai.db`(SQLite WAL) → 온라인 백업(`node:sqlite` backup)으로, -wal/-shm 제외(복원 때 삭제). RisuBard `save/.risubard-server.lock`은 백업·복원에서 제외. 시험 34개.
- [ ] 실제 RisuBard(31만 파일·26GB)에서 첫 백업 시간·디스크 여유·링크 시간 측정. 링크가 느리면 내용 주소 저장(manifest + objects, 링크 없음)으로 바꾸는 것 검토
- [ ] 복원 직후 열려 있던 리스 화면이 옛 DB를 다시 저장하는지 실기기 확인(현재 안내: 모두 새로고침)
- [ ] 윈도우(NTFS 하드링크)·Termux(링크 불가 → 복사로 대체) 확인
- [ ] 속도 측정(서버 저장 vs 플러그인 저장)
- [ ] (효과 있으면) 분석·임베딩 서버 실행

## 플러그인 수정(무중단) — 사용자 결정 2026-11-03, RisuBard 구현 2026-11-03 (feat/0.1.0)
리스는 플러그인이 다른 플러그인을 고치지 못하게 막았다(RisuAI PR #1572, 플러그인 API에서 plugins 필드 읽기 전용). Cellar가 대신 고친다.
- **허락(사용자 결정):** 리스 암호 입력은 넣지 않는다(로컬 실행 + 검증된 플러그인만 배포된다는 판단). Atelier 화면의 확인 창 + 고치기 전 백업으로 대신한다. 남는 위험: 설치된 아무 플러그인이나 Cellar 수정 주소를 부를 수 있음(사용자 인지). 리스 API 인증은 Cellar가 `<세이브>/__password`를 직접 읽어 `/api/login`으로 한다(RisuBard 소스로 확인: `savePath/__password`, `POST /api/login {password}` → `{token}`, 헤더 `risu-auth`).
- **새로고침:** 플러그인 iframe은 sandbox(allow-top-navigation 없음)라 리스 전체 새로고침 불가 → 고친 뒤 안내(Atelier 결과 화면). `Risuai.loadPlugins()`는 메모리 DB 기준이라 효과 미확인.
- [x] **RisuBard 구현(2026-11-03)** — `plugins.cjs`, `POST /cellar/plugins`(list·get·apply), features `plugins`, 시험 19개(단위 17 + 실행기 통합 2). 소스 조사(rpaddict/risubard 1fb48ea):
  - 플러그인 = `db.plugins`(RisuPlugin: name·displayName·script·arguments·realArg·version('3.0')·versionOfPlugin·updateURL…). 저장: `splitSecrets`가 top-level 키별로 `settings/app.json` 또는 `secrets/credentials.json`으로 나눈다 — 키 이름이 `key|token|secret|password|credential…`이거나 **배열 값 안에 그런 키가 있으면 배열째 secrets로** 간다(플러그인 인자 이름에 apiKey 등이 있으면 plugins 전체가 credentials.json). Cellar는 두 파일을 다 보고 있는 쪽을 고친다(둘 다 있으면 거절). `script`만 바꾸므로 키 구성이 안 바뀌어 위치도 안 바뀐다.
  - 파일마다 `.sha256` 사이드카. 리스의 외부 변경 감지 = 정식 파일들의 지문(크기+mtime(ns)+사이드카) 리비전이 '받아들인 리비전'과 다르면 `externalChangesAwaitingReview()` → 쓰기가 409 `EXTERNAL_CHANGES_PENDING`. `GET /api/external-changes` → `pending{revision, changes[], errors[]}`, `POST /api/external-changes/resolve {decision:"accept", revision}`(인증 + `x-session-id`)로 받아들임. 설정 파일 변경(kind settings)은 `reload:true`(탭 새로고침).
  - 세션 잠금(`session-lock.cjs`): 새 세션을 `/api/session`으로 등록하면 '새로 부팅한 세션'이라 사용자 제스처 헤더 없이도 쓰기는 통과하되 잠금을 뺏지는 않는다. 단 열린 탭이 그 뒤에 쓰면 우리 세션이 stale → resolve가 423 → Cellar는 새 세션을 등록해 한 번 더 시도.
  - `/api/external-edit/start·finish`는 외부 파일 감시 켜짐이 필요한데 소스 주석에 '외부 감시는 폐지(retired)'라 쓰지 않았다.
  - 포트 = `PORT` 환경변수(기본 7777), 데이터 폴더 = `RISUBARD_DATA_ROOT` 또는 `<cwd>/save`(실행기는 이제 `--save-dir` 기본값에 이 환경변수를 반영, `--risu-port` 추가).
- **실제 서버 미확인(사용자 확인 필요):** ① 우리가 고친 settings/app.json을 리스가 '외부 변경 검토'로 잡고 accept 되는지 ② 열린 화면의 이후 저장이 우리 수정을 덮는지 ③ 3.6MB 본문이 nativeFetch→/proxy2→Cellar로 지나는지(Atelier 자신을 고칠 때) ④ 고치기 전 세이브 백업 시간(31만 파일)과 '최근 5개' 보관에 수동 백업이 밀려나는 문제. 이 환경에서는 npm 레지스트리에 못 닿아 실제 RisuBard를 띄우지 못했다.
- 확인 방법(RisuBard 서버): `curl -s -X POST localhost:6011/cellar/plugins -H 'content-type: application/json' -d '{"action":"list"}'`(리스 프록시를 거치지 않는 서버 안에서). 그다음 Atelier 플러그인 탭 → ··· → 코드 수정에서 머리말만 그대로인 한 줄을 고쳐 보기(되돌리기 버튼으로 원복 가능). 스냅샷은 `dusk-data/plugin-backups/`.
- [x] (2026-11-03) RisuBard `mutate`·`export` 일반화(켜짐·별칭·인자값·순서·추가/교체·삭제·통째 바꾸기) + gzip 전송. 시험 57개. 실제 서버 미확인.
- [ ] **PocketRisu**(PocketRisu/PocketRisu): `save/risuai.db`(SQLite WAL, 'database/database.bin'은 chunkStore). 서버가 DB를 메모리(dbCache)에 둠 → 파일 직접 수정 금지, **리스 API로**: `/api/login`(암호)→JWT, `/api/session`(새 x-session-id, 사용자 제스처 헤더 없이 → 잠금 안 뺏고 '새 세션'이라 쓰기 통과), `/api/read`로 DB 받아 RisuSave 디코드 → plugins 블록(type 9, name 'plugins', JSON) 교체 → `/api/write` + `x-if-match` etag. 열린 화면은 409 → `rebaseTrackedLocalChangesOnLatestServerDb`로 서버 값 위에 자기 변경만 다시 얹음 → 덮어쓰기 없음. RisuSave 인코더/디코더를 Cellar에 구현해야 함(가장 큰 작업; 서버 쪽 `utils.cjs` decodeRisuSave·encodeRisuSaveLegacy 참고, 청크/스텁 처리 주의).
- [ ] **원본 RisuAI**(kwaroran/RisuAI): `save/`에 hex 이름 파일, `database/database.bin` = RisuSave(`RISUSAVE\0` + 블록, plugins 블록 type 9). 서버는 파일 저장만 → 리스 안 멈춰도 됨. **충돌 방지 없음** → 열린 화면이 다음 저장 때 덮어씀. 고친 직후 모두 새로고침 경고 필수. 마지막 순서.
- 순서: RisuBard(끝) → PocketRisu → 원본.
- Atelier 쪽(feat/1.8.3): `src/data/cellarplugins.js`, `src/ui/screens/pluginedit.js`, 플러그인 탭 행 메뉴 '코드 수정'. 고치기 전 세이브 백업은 Atelier 화면이 기존 `/cellar/backup`으로 먼저 돌리고(기본 켜짐), 설정 파일 스냅샷은 서버가 apply마다 항상 만든다.


## 에셋 빠른 쓰기 (2026-11-03)
- `assets.cjs`(+ 공통 `risu-client.cjs`, plugins.cjs도 이걸 씀) · `POST /cellar/assets` status/missing/put. features에 "assets".
- 호스트별: risuai=save/<hex(key)> 직접(임시→rename, fsync 없음) / risubard·pocketrisu=로컬 /api/assets/bulk-write(50개·24MB씩).
- 시험: tests/assets.test.js (Cellar 65 통과). 진짜 서버로는 아직 확인 못 함.
- 남은 일: 카드(.charx/png/risum) 서버측 풀기, 플러그인 쪽에서 미리 넣은 에셋으로 캐릭터 등록, Atelier UI, RisuBard 인덱스 직접 쓰기(재시작 필요) 모드, 사용자 실측(`node tools/fsync-bench.cjs ~/bench-tmp 1000 200`).

## 자체 업데이트 (2026-11-03)
- `update.cjs` + `POST /cellar/update`(check/apply/rollback), 실행기 IPC `restart`(Cellar만 즉시 재시작, 실패 횟수 초기화). features에 "update". 시험: tests/update.test.js(실제 git 저장소 사용). Cellar 71 통과. 서버 실물(pm2) 확인은 아직.
- 플러그인 수정/관리 응답에 `timing`(plan·login·check·snapshot·write·detect·accept·final·total, ms)을 넣고 로그에도 남김 — 느림 원인 측정용.

## 플러그인 수정 3호스트 (2026-11-03)
- `risusave.cjs`(RISUSAVE 블록에서 plugins 블록만 교체, 옛 형식은 호스트 msgpackr·fflate), `plugins.cjs`가 호스트별 load/write/verify. risuai: 파일 + 쓴 뒤 재확인(`overwritten`), pocketrisu: /api/read·/api/write(x-if-match). 스냅샷은 database.bin 대신 plugins.json.gz.
- 시험: tests/plugins-hosts.test.js (Cellar 80 통과). **미확인**: 진짜 PocketRisu·리스AI 서버, 옛 형식은 가짜 코덱으로만 시험(진짜 msgpackr 없음), PocketRisu 쓰기 뒤 브라우저 쪽 동작, 블록 형식이 아닌 세이브.
- Cellar→리스 호출은 설정한 주소가 안 되면 PORT·7777·6001을 시도하고 성공한 주소를 기억. 실패 메시지에 시도한 주소와 원인 코드(ECONNREFUSED 등)를 담음.
- 서버 자식은 실행기와 IPC가 끊기면 스스로 종료(disconnect), stdout/stderr EPIPE 무시. pm2가 실행기만 죽여 고아 Cellar가 6011을 붙잡던 문제(2026-11-03 사용자 로그) 대응.
- 고아 Cellar 자동 인수: 포트가 사용 중이고 health의 dataId(데이터 폴더 해시)가 같으면 pid를 SIGTERM으로 끄고 이어받음. 설치기는 pm2 start에 --kill-timeout 10000.
- 버그 수정(2026-11-03): 업데이트 후 검사가 cellar-start.cjs를 require해서 실행기가 통째로 켜지며 고아 Cellar가 생기던 문제. 이제 node --check(문법)만 하고, 불러오면 실행되는 cellar-start.cjs·setup.cjs는 절대 require하지 않는다.
- 프로세스 증식 방지(2026-11-03): cellar-start.cjs는 require() 금지(throw), 실행기가 띄운 프로세스(DUSK_CELLAR_LAUNCHER=1) 안에서 실행기가 또 켜지면 종료, 리스에 넘기는 Node 옵션에서 -e/-p/-c 제거. (옛 update 검사가 `node -e require(cellar-start.cjs)`로 실행기를 재귀 실행해 서버 CPU 100% 유발)
- 정정(2026-11-03): require.main 가드는 pm2가 ESM import로 실행기를 불러올 때 정상 실행까지 막아 리스가 안 뜸 → execArgv(-e/-p)로만 거부하도록 변경. ESM import 실행 시험 추가.
- 실측(2026-11-03, 사용자 RisuBard): 플러그인 수정 total 10.8s = accept 7.7s + detect 1.5s(RisuBard) + plan/check 0.9s + write 0.34s … RisuBard 쪽이 약 86%. 우리 쪽은 두 번 읽던 설정 파일을 한 번으로(파일이 그대로면 처음 계산 재사용).
