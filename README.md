# Dusk Cellar

[Dusk Atelier](https://github.com/Pyser08/Dusk-Atelier) 플러그인의 백그라운드 서버예요. 아틀리에 아래층의 저장고처럼, 리스(RisuAI 서버) 옆에서 조용히 기억을 보관하고 일해요.

> 리스와 함께 켜지고 꺼지는 실행 구조, 연결 확인(`/cellar/health`), 기억 저장·읽기(`/cellar/mem`), 세이브 백업·복원(`/cellar/backup`)이 있어요. 플러그인은 Cellar가 없어도 지금처럼 동작해요.

## 준비물

- Node.js 22 이상 (리스를 돌리는 그 Node)
- 직접 돌리는 리스 서버 (`server/node/server.cjs`가 있는 RisuAI·RisuBard 등)
- (권장) pm2 — 없으면 설치할지 물어봐요

## 설치 (한 번만)

리스 폴더 안에서:

```sh
git clone https://github.com/Pyser08/Dusk-Cellar
cd Dusk-Cellar
node setup.cjs
```

`setup.cjs`가 차례로 해 줘요.

1. **리스 찾기:** 위쪽 폴더에서 `server/node/server.cjs`를 찾아요(없으면 옆 폴더도 뒤져요).
2. **리스 빌드:** `pnpm-lock.yaml`이 있으면 pnpm, 없으면 npm으로 `install` → `build`.
3. **pm2 정리:** 등록된 목록을 번호로 보여 주고 지울 것을 고르게 해요. 리스를 직접 켜던 항목은 `지우기 추천`으로 표시돼요. 이제 Cellar 실행기가 리스를 대신 켜서, 남겨 두면 리스가 두 번 켜져 포트가 부딪혀요.
   - 엔터 = 지우지 않음 · `a` = 추천만 · `1,3` = 그 번호들
4. **함께 실행:** pm2에 `risu`라는 이름으로 실행기를 등록하고 저장해요. 리스와 Dusk Cellar가 함께 켜지고 함께 꺼져요.
   - 이어서 **부팅 시 자동 실행**(`pm2 startup`)을 켤지 물어요. 관리자 암호를 물을 수 있어요. 윈도우·Termux는 방법만 안내해요.
5. **확인:** Cellar가 응답하는지 봐요. 그다음 리스에서 Dusk Atelier **설정 → 서버 → Dusk Cellar**가 '연결됨'이면 끝이에요(주소·토큰 입력 없음).

### 옵션

| 옵션 | 뜻 |
|---|---|
| `--risu <경로>` | 리스 시작 파일을 직접 지정 |
| `--name <이름>` | pm2 이름 (기본 `risu`, 겹치면 `risu-2`…) |
| `--dusk-port <포트>` | Cellar 포트 (기본 6011) |
| `--no-build` | 빌드 건너뛰기 |
| `--no-startup` | 부팅 시 자동 실행 등록 건너뛰기 |
| `--no-pm2` | pm2 없이 지금 창에서 바로 실행 |
| `--yes` | 묻지 않고 기본값 (추천 항목은 지움) |
| `--dry-run` | 실행할 명령만 보여 주기 |

## pm2 없이 직접 실행

```sh
node Dusk-Cellar/cellar-start.cjs          # 리스 폴더에서
node Dusk-Cellar/cellar-start.cjs -- --port 6001   # -- 뒤는 리스에 그대로
```

- 리스를 먼저 켜고, Cellar는 별도 프로세스로 켜요(서로 오류가 번지지 않아요).
- 리스가 꺼지면 Cellar도 끄고 같은 종료 코드로 끝나요.
- Cellar만 죽으면 Cellar만 다시 켜요(최대 5번).
- 리스 파일은 읽지도 고치지도 않아요. Cellar 데이터는 `Dusk-Cellar/dusk-data/`에만 써요.

## 기억 저장소 (`/cellar/mem`)

플러그인이 서버를 감지하면 장기기억을 여기에만 보내요(플러그인 안에는 저장하지 않고, 연결이 끊긴 동안만 임시로 쌓아 두었다가 다시 올려요).

| 요청 | 하는 일 |
|---|---|
| `GET /cellar/mem?prefix=` | 키 목록(rev·수정 시각·크기) |
| `GET /cellar/mem/<키>?ifRev=` | 값과 rev (`ifRev`가 지금 rev와 같으면 값 없이 `same: true`) |
| `PUT /cellar/mem/<키>` `{value, baseRev?, opId?}` | 쓰기 |
| `DELETE /cellar/mem/<키>?baseRev=` | 삭제 |
| `POST /cellar/mem/batch` `{ops:[{op:"put"\|"del", key, ...}]}` | 여러 개 한 번에(차례대로, 하나가 실패해도 나머지는 계속) |

- 키는 `dusk.mem.`으로 시작해야 하고, 값은 문자열(최대 16MB)이에요.
- `baseRev`: 내가 본 rev가 지금도 그대로일 때만 써요. 달라졌으면 `409`와 현재 rev를 돌려줘요(`0` = 아직 없어야 함). 생략하면 덮어써요.
- `opId`: 같은 쓰기를 다시 보내도(연결이 끊겼다 재전송) 한 번만 반영돼요. 키마다 최근 16개를 기억해요.
- 데이터는 `dusk-data/mem/`에 키마다 파일 하나로 있어요. 하루 첫 쓰기 전에 `dusk-data/snapshots/<날짜>/`에 통째로 복사해 두고 7일치만 남겨요.
- `store.cjs`는 `cellar-start.cjs`와 같은 폴더에 있어야 해요.

## 백업·복원 (`/cellar/backup`)

리스 세이브 폴더(`<리스>/save` — RisuAI·RisuBard·PocketRisu 모두 여기에 전부 저장해요)와 Cellar 기억(`dusk-data/mem`)을 통째로 백업해요.

- **압축하지 않아요.** 세이브 대부분은 이미 압축된 이미지라 다시 압축해도 거의 안 줄고 시간만 걸려요. 대신 **바뀐 파일만** 복사해요. 바뀌지 않은 파일은 직전 백업과 하드링크로 공유해서 디스크도 시간도 거의 안 들어요. 각 백업은 그대로 완전한 폴더예요(`dusk-data/backups/<날짜-시각>/save`, `mem`).
  - 시험(파일 2만 개, 약 1GB): 첫 백업 4.8초, 10개 바뀐 뒤 백업 3.0초, 복원 1.0초. 같은 폴더 `tar.gz` 34.6초, 풀기 7.2초.
- **리스 파일과는 링크하지 않아요.** 리스가 파일을 제자리에서 고쳐 써도 백업은 바뀌지 않아요.
- 리스가 도는 중에도 백업할 수 있어요. 복사하는 동안 바뀐 파일은 한 번 더 훑어서 다시 담아요.
- PocketRisu처럼 SQLite(`save/risuai.db`)에 저장하는 리스는 SQLite 온라인 백업으로 깨지지 않게 담아요(이 파일은 매번 통째로, Node 22.16 이상). RisuBard 실행 잠금 폴더(`.risubard-server.lock`)는 건드리지 않아요.
- **복원**은 실행기가 리스와 Cellar를 잠깐 멈추고 → 지금 상태를 '복원 전 자동' 백업으로 남기고 → 다른 파일만 바꾸고 백업에 없는 파일은 지운 뒤 → 다시 켜요. 복원 직후에는 **리스를 열어 둔 화면을 모두 새로고침**하세요(새로고침 전 화면이 옛 데이터를 다시 저장할 수 있어요).
- 기본 5개를 보관해요(`--keep`). 세이브 위치가 다르면 `--save-dir`.

| 요청 | 하는 일 |
|---|---|
| `GET /cellar/backup` | 백업 목록과 지금 작업 상태 |
| `POST /cellar/backup` `{action:"create", label?}` | 백업 시작(작업으로 돌고 GET으로 진행 확인) |
| `POST /cellar/backup` `{action:"restore", id}` | 복원(리스가 잠깐 꺼졌다 켜짐) |
| `POST /cellar/backup` `{action:"delete", id}` | 백업 지우기 |

## 플러그인 코드 수정 (`/cellar/plugins`, RisuBard만)

리스는 플러그인이 다른 플러그인을 고치지 못하게 막았어요(RisuAI PR #1572). 그래서 Cellar가 대신 고쳐요. `/cellar/health`의 `features`에 `plugins`가 있으면 쓸 수 있어요(세이브 폴더가 RisuBard 모양일 때). PocketRisu·원본 RisuAI는 `501`이에요(다음 단계).

| 요청 | 하는 일 |
|---|---|
| `POST /cellar/plugins` `{action:"list"}` | 설치된 플러그인 목록(이름·버전·크기·코드 해시·인자 **이름**만. 코드와 인자 값은 안 줘요) |
| `POST /cellar/plugins` `{action:"get", name, index?}` | 그 플러그인의 코드와 해시 |
| `POST /cellar/plugins` `{action:"apply", edits:[{name, index?, expectSha, script}]}` | 코드 바꾸기(한 번에 20개까지) |

`apply`의 순서와 안전장치:
1. **입력·해시 확인** — `expectSha`(지금 코드의 sha256)가 다르면 `409`(`conflict`, `currentSha`). 머리말 `//@name`이 플러그인 이름과 다르면 `400`(이름을 바꾸면 플러그인 저장소·업데이트가 끊겨요). 같은 이름이 둘이면 `index` 필요.
2. **로그인** — `<세이브>/__password`를 읽어 리스 `/api/login`으로 로그인하고 새 세션을 등록해요. 리스 암호를 따로 묻지 않아요(로컬 실행 + 플러그인 화면의 확인 창이 허락을 대신해요). 리스 주소는 `--risu-port`(기본 `PORT` 환경변수, 없으면 7777). 안 되면 `424`, 파일은 안 건드려요.
3. **검토 대기 없음 확인** — 리스에 이미 처리 안 된 외부 변경이 있으면 `409`(`pending`)로 멈춰요. 남의 변경을 대신 받아들이지 않아요.
4. **파일 스냅샷** — 고칠 파일(과 `.sha256`)을 `dusk-data/plugin-backups/<시각>/`에 복사해 둬요(최근 20개).
5. **파일 쓰기** — `settings/app.json`(플러그인 인자 이름에 key·token 같은 말이 있으면 `secrets/credentials.json`)의 그 플러그인 `script`만 바꿔요. 들여쓰기·줄바꿈은 원래대로, 사이드카 체크섬도 새로 써요. 임시 파일 → 바꿔치기로 써요.
6. **받아들이기** — 리스가 바뀐 파일을 '외부 변경'으로 잡으면, 바뀐 파일이 **우리 것뿐일 때만** `/api/external-changes/resolve`(accept)로 받아들여요. 다른 파일이 섞여 있으면 받아들이지 않고 `409`(`written: true`, `others`).
- 쓴 뒤에 실패하면 되돌리지 않고(리스는 파일 지문에 mtime을 써서 되돌려도 '검토 대기'가 남아요) 쓴 상태 그대로 `502`/`409`와 `written: true`, `snapshot`을 알려요. 리스 화면의 '외부 변경 검토'에서 받아들이면 돼요.
- 목록 전체를 바꾸는 `mutate`·`export`도 있어요(플러그인 매니저 기능용): `{action:"mutate", ops:[...], expectListSha?}` — ops는 `set`(켜짐·표시이름·별칭·인자·인자값·링크·업데이트 주소만), `remove`, `add`(같은 이름이면 `replace`+`keepSettings`), `order`(현재 번호를 모두 한 번씩), `replaceAll`(통째 바꾸기). `order`·`replaceAll`은 `list`가 준 `listSha`가 필요하고 그새 바뀌었으면 `409`. 모두 `apply`와 같은 순서(스냅샷 → 쓰기 → 리스가 받아들임)로 처리돼요. `{action:"export", gzip?}`은 코드·인자값까지 전부 줘요(백업용).
- 큰 코드는 gzip으로 주고받아요: `get`에 `gzip:true`를 주면 `scriptZ`(gzip+base64)로, `apply`는 `script` 대신 `scriptZ`도 받아요(리스 프록시가 응답을 조각조각 넘겨서 수 MB 코드가 느린 것을 줄이려고).
- 성공하면 `needsReload: true` — 리스를 새로고침해야 새 코드로 돌아요(열린 화면은 옛 코드 그대로).
- 남는 위험: 설치된 **아무 플러그인이나** 이 주소를 부를 수 있어요. 믿을 수 있는 플러그인만 설치하세요.
- 실제 RisuBard 서버로는 아직 시험하지 못했어요(소스 조사 + 가짜 서버 시험). 확인 목록은 `HandOff/STATE.md`.

## 보안

- Cellar는 기본으로 `127.0.0.1`(이 기기)에서만 받아요.
- 플러그인은 리스 서버의 프록시를 거쳐 들어와요. 그 프록시는 **리스 암호로 막혀 있어서**, 같은 기기(127.0.0.1)에서 온 요청은 토큰 없이 받아요. 그래서 리스 주소가 IP든 도메인(duckdns 등)이든 https든 상관없이 연결돼요.
- 다른 기기에서 직접 열고 싶다면(`--dusk-host 0.0.0.0`) `--require-token`을 함께 쓰고 `dusk-data/token.txt` 토큰을 쓰세요. `dusk-data/`는 다른 사람에게 보내지 마세요.

## 개발

```sh
node --test tests/*.js tests/*.mjs
```

Node 기본 모듈만 써요(`npm install` 불필요).

## 에셋 빠른 쓰기 `/cellar/assets` (POST)

봇·모듈 가져오기에서 에셋(이미지·소리)을 리스 저장소에 한꺼번에 넣는 길이에요. 키는 `assets/<sha256>.<확장자>`만 받고, 내용의 해시가 키와 다르면 거부해요.

- `{action:"status"}` → `{ok, host, sink}` (`direct`=순정 리스AI 파일 직접 쓰기, `bulk`=RisuBard·PocketRisu의 `/api/assets/bulk-write`)
- `{action:"missing", keys:[…]}` → 서버에 없는 키만 돌려줘요(최대 5000개)
- `{action:"put", entries:[{key, value(base64)}]}` → 한 번에 200개까지, 요청 본문 64MB까지
- 서버가 실행 중이어도 쓸 수 있어요. 호스트가 알 수 없는 폴더면 501이에요.
