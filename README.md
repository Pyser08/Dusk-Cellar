# Dusk Cellar

[Dusk Atelier](https://github.com/Pyser08/Dusk-Atelier) 플러그인의 백그라운드 서버예요. 아틀리에 아래층의 저장고처럼, 리스(RisuAI 서버) 옆에서 조용히 기억을 보관하고 일해요.

> 지금은 **뼈대 단계**예요. 리스와 함께 켜지고 꺼지는 실행 구조와 연결 확인(`/cellar/health`)까지만 있어요. 기억 백업·검색 기능은 다음 단계에서 붙어요. 플러그인은 Cellar가 없어도 지금처럼 동작해요.

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

## 보안

- Cellar는 기본으로 `127.0.0.1`(이 기기)에서만 받아요.
- 플러그인은 리스 서버의 프록시를 거쳐 들어와요. 그 프록시는 **리스 암호로 막혀 있어서**, 같은 기기(127.0.0.1)에서 온 요청은 토큰 없이 받아요. 그래서 리스 주소가 IP든 도메인(duckdns 등)이든 https든 상관없이 연결돼요.
- 다른 기기에서 직접 열고 싶다면(`--dusk-host 0.0.0.0`) `--require-token`을 함께 쓰고 `dusk-data/token.txt` 토큰을 쓰세요. `dusk-data/`는 다른 사람에게 보내지 마세요.

## 개발

```sh
node --test tests/*.js tests/*.mjs
```

Node 기본 모듈만 써요(`npm install` 불필요).
