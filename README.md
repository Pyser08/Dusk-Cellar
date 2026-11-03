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
- **복원**은 실행기가 리스와 Cellar를 잠깐 멈추고 → 지금 상태를 '복원 전 자동' 백업으로 남기고 → 다른 파일만 바꾸고 백업에 없는 파일은 지운 뒤 → 다시 켜요. 복원 직후에는 **리스를 열어 둔 화면을 모두 새로고침**하세요(새로고침 전 화면이 옛 데이터를 다시 저장할 수 있어요).
- 기본 5개를 보관해요(`--keep`). 세이브 위치가 다르면 `--save-dir`.

| 요청 | 하는 일 |
|---|---|
| `GET /cellar/backup` | 백업 목록과 지금 작업 상태 |
| `POST /cellar/backup` `{action:"create", label?}` | 백업 시작(작업으로 돌고 GET으로 진행 확인) |
| `POST /cellar/backup` `{action:"restore", id}` | 복원(리스가 잠깐 꺼졌다 켜짐) |
| `POST /cellar/backup` `{action:"delete", id}` | 백업 지우기 |

## 보안

- Cellar는 기본으로 `127.0.0.1`(이 기기)에서만 받아요.
- 플러그인은 리스 서버의 프록시를 거쳐 들어와요. 그 프록시는 **리스 암호로 막혀 있어서**, 같은 기기(127.0.0.1)에서 온 요청은 토큰 없이 받아요. 그래서 리스 주소가 IP든 도메인(duckdns 등)이든 https든 상관없이 연결돼요.
- 다른 기기에서 직접 열고 싶다면(`--dusk-host 0.0.0.0`) `--require-token`을 함께 쓰고 `dusk-data/token.txt` 토큰을 쓰세요. `dusk-data/`는 다른 사람에게 보내지 마세요.

## 개발

```sh
node --test tests/*.js tests/*.mjs
```

Node 기본 모듈만 써요(`npm install` 불필요).
