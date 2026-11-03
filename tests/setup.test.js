const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const S = require("../setup.cjs");

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dusk-setup-")));
const touch = (p, s = "") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

test("리스 폴더 안에 클론하면 위쪽에서 시작 파일을 찾는다", () => {
  const risu = tmp();
  touch(path.join(risu, "server/node/server.cjs"));
  const clone = path.join(risu, "Dusk-Cellar");
  fs.mkdirSync(clone);
  const e = S.findRisuEntry(clone);
  assert.equal(e, path.join(risu, "server/node/server.cjs"));
  assert.equal(S.risuRootOf(e), risu);
});

test("리스 옆에 클론했으면 바로 위 폴더 아래를 뒤져 찾는다 (node_modules는 건너뜀)", () => {
  const top = tmp();
  touch(path.join(top, "x/node_modules/server/node/server.cjs"));
  touch(path.join(top, "RisuAI/server/node/server.cjs"));
  const clone = path.join(top, "Dusk-Cellar");
  fs.mkdirSync(clone);
  assert.equal(S.findRisuEntry(clone), path.join(top, "RisuAI/server/node/server.cjs"));
});

test("못 찾으면 null", () => {
  const top = tmp();
  fs.mkdirSync(path.join(top, "c"));
  assert.equal(S.findRisuEntry(path.join(top, "c"), { up: 1 }), null);
});

test("빌드 계획: pnpm-lock+pnpm이면 pnpm, 아니면 npm, build 스크립트 없으면 install만", () => {
  const r = tmp();
  touch(path.join(r, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
  assert.deepEqual(S.buildPlan(r, true), [["npm", ["install"]], ["npm", ["run", "build"]]]);
  touch(path.join(r, "pnpm-lock.yaml"));
  assert.deepEqual(S.buildPlan(r, true), [["pnpm", ["install"]], ["pnpm", ["run", "build"]]]);
  assert.deepEqual(S.buildPlan(r, false)[0], ["npm", ["install"]]);
  touch(path.join(r, "package.json"), "{}");
  assert.deepEqual(S.buildPlan(r, true), [["pnpm", ["install"]]]);
  assert.deepEqual(S.buildPlan(tmp(), true), []);
});

test("pm2 목록: 리스를 직접 켜던 항목과 예전 실행기를 추천", () => {
  const rows = S.pm2Rows([
    { pm_id: 0, name: "risu", pm2_env: { status: "online", pm_exec_path: "/srv/risu/server/node/server.cjs" } },
    { pm_id: 1, name: "bot", pm2_env: { status: "online", pm_exec_path: "/srv/bot/index.js" } },
    { pm_id: 2, name: "old", pm2_env: { status: "stopped", pm_exec_path: "/srv/risu/Dusk/cellar-start.cjs" } },
  ], "/srv/risu/server/node/server.cjs");
  assert.deepEqual(rows.map((r) => r.recommend), [true, false, true]);
});

test("지울 번호 고르기", () => {
  const rows = [{ recommend: true }, { recommend: false }, { recommend: true }];
  assert.deepEqual(S.parsePick("", rows), []);
  assert.deepEqual(S.parsePick("a", rows), [rows[0], rows[2]]);
  assert.deepEqual(S.parsePick("2, 1 2", rows), [rows[1], rows[0]]);
  assert.equal(S.parsePick("4", rows), null);
  assert.equal(S.parsePick("x", rows), null);
});

test("pm2 이름이 겹치면 뒤에 번호를 붙인다 (지울 항목은 비어 있는 셈)", () => {
  const rows = [{ name: "risu" }, { name: "risu-2" }];
  assert.equal(S.pickName("risu", rows, []), "risu-3");
  assert.equal(S.pickName("risu", rows, [rows[0]]), "risu");
});

test("전체 흐름(가짜 pm2·npm): 찾기 → 빌드 → 추천 항목 지우기 → 실행기 등록 → 저장", () => {
  const risu = tmp();
  touch(path.join(risu, "server/node/server.cjs"));
  touch(path.join(risu, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
  const clone = path.join(risu, "Dusk-Cellar");
  fs.mkdirSync(clone);
  for (const f of ["setup.cjs", "cellar-start.cjs"]) fs.copyFileSync(path.join(__dirname, "..", f), path.join(clone, f));
  const bin = tmp(), logf = path.join(bin, "calls.log");
  const fake = (name, extra = "") => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${logf}"\n${extra}\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  };
  fake("npm");
  fake("pm2", `[ "$1" = "jlist" ] && echo '[{"pm_id":7,"name":"risu","pm2_env":{"status":"online","pm_exec_path":"${risu}/server/node/server.cjs"}}]'`);
  const r = spawnSync(process.execPath, [path.join(clone, "setup.cjs"), "--yes"], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}` }, timeout: 40000,
  });
  const calls = fs.readFileSync(logf, "utf8").split("\n").filter(Boolean).filter((l) => !/ (--version|-v)$/.test(l));
  assert.deepEqual(calls.slice(0, 2), ["npm install", "npm run build"], r.stdout);
  assert.ok(calls.includes("pm2 delete 7"), r.stdout);
  const start = calls.find((l) => l.startsWith("pm2 start"));
  assert.ok(start.includes(`${clone}/cellar-start.cjs --name risu --cwd ${risu} -- --risu ${risu}/server/node/server.cjs`), start);
  assert.ok(calls.includes("pm2 save"));
});

test("--yes 없이(비대화) 실행하면 pm2 항목을 지우지 않는다", () => {
  const rows = S.pm2Rows([{ pm_id: 1, name: "risu", pm2_env: { pm_exec_path: "/a/server/node/server.cjs" } }], "/a/server/node/server.cjs");
  assert.deepEqual(S.parsePick("", rows), []);
});
