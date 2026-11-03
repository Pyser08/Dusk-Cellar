# Dusk Cellar — 진행 상황

플러그인 [Dusk Atelier](https://github.com/Pyser08/Dusk-Atelier)의 백그라운드 서버. 작업 규칙은 Dusk-Atelier의 `HandOff/README.md`를 따른다(버전·브랜치·main은 사용자 지시가 있을 때만, 버그는 실패 시험 먼저, 끝낼 때 시험 통과 확인, 이 파일 갱신).

- 작업 브랜치는 Atelier main의 `HandOff/README.md` '현재 작업 브랜치' 표가 기준이다. 브랜치가 바뀌면 그 표를 고친다.

## 원칙
- 선택 기능: Cellar가 없어도 플러그인은 지금처럼 동작해야 한다.
- 리스 프로세스에 섞지 않는다. 실행기(`cellar-start.cjs`)가 리스와 Cellar를 따로 켠다.
- 리스 파일·데이터는 읽지도 고치지도 않는다. Cellar 데이터는 `dusk-data/`에만.
- Node 기본 모듈만(설치 불필요). Node 22 이상.
- 기본 127.0.0.1만. loopback 요청은 토큰 없이(리스 프록시가 리스 암호로 보호), 그 외 또는 `--require-token`이면 토큰(`dusk-data/token.txt`) 필수.

## 파일
- `setup.cjs` — 한 번 설치: 리스 찾기(위쪽 4단계 → 옆 폴더 4단계, node_modules 제외) → 빌드(pnpm-lock+pnpm이면 pnpm, 아니면 npm; build 스크립트 없으면 install만) → pm2 목록·지울 것 고르기(리스 직접 실행·옛 실행기 '추천', 비대화면 지우지 않음, `--yes`면 추천만) → `pm2 start cellar-start.cjs --name risu --cwd <리스> -- --risu …` + `pm2 save` → 부팅 자동 실행(`startupPlan`: 리눅스 systemd·맥 launchd를 sudo env PATH=… pm2 startup으로, root는 바로, 윈도우·Termux는 안내만, `--no-startup`) → health 확인. 순수 함수는 module.exports로 시험.
- `cellar-start.cjs` — 실행기 + 서버(같은 파일 `--role-server`). 리스 종료 → Cellar 종료·같은 코드, Cellar만 죽으면 최대 5번 재시작(1·2·4·8·16초), 포트 사용 중(78)이면 리스만.
- `store.cjs` — 기억 저장소(키-값 파일 저장, rev·baseRev 충돌 검사, opId 재전송 무시, 일별 스냅샷 7일). `cellar-start.cjs`의 `/cellar/mem*` 주소가 사용.
- `backup.cjs` — 세이브 백업·복원(바뀐 파일만 복사, 나머지는 직전 백업과 하드링크, 리스 파일과는 링크 안 함). 복원은 실행기 `doRestore`가 IPC 메시지(type restore)로 받아 리스·Cellar를 멈추고 '복원 전 자동' 백업 후 동기화하고 다시 켠다.
- `tests/` — `node --test tests/*.js tests/*.mjs` (34개).

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

## 다음 작업: 플러그인 수정(무중단) — 사용자 결정 2026-11-03, 미착수
리스는 플러그인이 다른 플러그인을 고치지 못하게 막았다(RisuAI PR #1572, 플러그인 API에서 plugins 필드 읽기 전용). Cellar가 대신 고친다.
- **허락(사용자 결정 2026-11-03):** 리스 암호 입력은 넣지 않는다(로컬 실행 + 검증된 플러그인만 배포된다는 판단). Atelier 화면의 확인 창 + 고치기 전 Cellar 증분 백업 자동으로 대신한다. 남는 위험: 설치된 아무 플러그인이나 Cellar 수정 주소를 부를 수 있음(사용자 인지). 리스 API 인증(PocketRisu `/api/login`)은 Cellar가 `save/__password`를 직접 읽어서 한다(원본·PocketRisu 동일 위치, RisuBard 확인 필요).
- **새로고침:** 플러그인 iframe은 sandbox(allow-top-navigation 없음)라 리스 전체 새로고침 불가 → 고친 뒤 안내. `Risuai.loadPlugins()`는 메모리 DB 기준이라 효과 미확인.
- 호스트별(소스 조사 결과, 실기기 미확인):
  1. **RisuBard**(조사: rpaddict/RisuBard): 데이터가 `save/kv` + 정식 파일(`save/settings/app.json`, 비밀 이름 키가 섞이면 `save/secrets/credentials.json`)로도 풀려 있고, 바깥 수정 감지·사용자 검토(EXTERNAL_CHANGES_PENDING) 및 `/api/external-edit/start`·`finish`(외부 파일 감시 켜져 있어야 함, auth+active session 필요)가 있다. 플러그인 목록은 app.json의 `plugins`. → app.json 수정 후 리스의 검토/채택 흐름을 쓰면 무중단·덮어쓰기 없음. sha256 검증 파일 여부(`readCanonicalJson`) 확인 필요.
  2. **PocketRisu**(PocketRisu/PocketRisu): `save/risuai.db`(SQLite WAL, 'database/database.bin'은 chunkStore). 서버가 DB를 메모리(dbCache)에 둠 → 파일 직접 수정 금지, **리스 API로**: `/api/login`(암호)→JWT, `/api/session`(새 x-session-id, 사용자 제스처 헤더 없이 → 잠금 안 뺏고 '새 세션'이라 쓰기 통과), `/api/read`로 DB 받아 RisuSave 디코드 → plugins 블록(type 9, name 'plugins', JSON) 교체 → `/api/write` + `x-if-match` etag. 열린 화면은 409 → `rebaseTrackedLocalChangesOnLatestServerDb`로 서버 값 위에 자기 변경만 다시 얹음 → 덮어쓰기 없음. RisuSave 인코더/디코더를 Cellar에 구현해야 함(가장 큰 작업; 서버 쪽 `utils.cjs` decodeRisuSave·encodeRisuSaveLegacy 참고, 청크/스텁 처리 주의).
  3. **원본 RisuAI**(kwaroran/RisuAI): `save/`에 hex 이름 파일, `database/database.bin` = RisuSave(`RISUSAVE\0` + 블록, plugins 블록 type 9). 서버는 파일 저장만 → 리스 안 멈춰도 됨. **충돌 방지 없음** → 열린 화면이 다음 저장 때 덮어씀. 고친 직후 모두 새로고침 경고 필수. 마지막 순서.
- 순서 제안: RisuBard → PocketRisu → 원본. Cellar `POST /cellar/plugins`(action list/apply, password) + Atelier 플러그인 탭에 수정 화면(미리 보기·암호·결과).
