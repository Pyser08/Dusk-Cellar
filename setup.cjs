#!/usr/bin/env node
// Dusk Cellar 설치기 — 리스 폴더 안에 이 저장소를 클론한 뒤 `node setup.cjs` 한 번이면 된다.
//
//   1. 리스 시작 파일(server/node/server.cjs)을 자동으로 찾는다 (이 폴더의 위쪽 → 아래쪽 순)
//   2. 리스를 빌드한다 (pnpm-lock.yaml이 있으면 pnpm, 없으면 npm: install → build)
//   3. pm2에 이미 등록된 프로세스 목록을 보여 주고, 지울 것을 고르게 한다
//      (리스를 직접 돌리던 항목은 '추천'으로 표시 — 이제 실행기가 리스를 대신 켜므로 두 번 켜지지 않게)
//   4. pm2로 실행기(cellar-start.cjs)를 등록한다 → 리스 + Dusk Cellar가 함께 켜진다. 그리고 pm2 save
//   5. Dusk Cellar가 응답하는지 확인한다
//
// 옵션: --risu <server.cjs 경로>  --name <pm2 이름(기본 risu)>  --dusk-port <포트(기본 6011)>
//       --no-build  --no-pm2(pm2 없이 바로 실행)  --yes(묻지 않고 기본값)  --dry-run(명령만 보여 줌)
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const readline = require("node:readline");

const WIN = process.platform === "win32";
const SKIP = new Set(["node_modules", ".git", ".svelte-kit", "dist", "build", ".cache"]);
const ENTRY = path.join("server", "node", "server.cjs");

// ── 순수 함수 (시험 대상) ──

// 이 폴더 위쪽(최대 4단계)에서 먼저 찾고, 없으면 바로 위 폴더 아래(최대 4단계)를 뒤진다
function findRisuEntry(start, { up = 4, down = 4 } = {}) {
  let dir = path.resolve(start);
  for (let i = 0; i <= up; i++) {
    const c = path.join(dir, ENTRY);
    if (fs.existsSync(c)) return c;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const base = path.dirname(path.resolve(start));
  const self = path.resolve(start);
  const walk = (d, depth) => {
    if (depth > down) return null;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    const c = path.join(d, ENTRY);
    if (fs.existsSync(c)) return c;
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (p === self) continue;
      const r = walk(p, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(base, 0);
}
const risuRootOf = (entry) => path.dirname(path.dirname(path.dirname(entry)));

// 빌드 명령: pnpm-lock이 있고 pnpm이 있으면 pnpm, 아니면 npm. build 스크립트가 없으면 install만.
function buildPlan(root, hasPnpm) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch { return []; }
  const pm = fs.existsSync(path.join(root, "pnpm-lock.yaml")) && hasPnpm ? "pnpm" : "npm";
  const plan = [[pm, ["install"]]];
  if (pkg?.scripts?.build) plan.push([pm, ["run", "build"]]);
  return plan;
}

// pm2 jlist → 보기 좋은 목록. 리스 시작 파일을 직접 돌리던 것과 예전 실행기는 '추천'
function pm2Rows(list, entry) {
  const norm = (p) => (p ? path.resolve(p).toLowerCase() : "");
  const e = norm(entry);
  return (Array.isArray(list) ? list : []).map((p) => {
    const script = p?.pm2_env?.pm_exec_path ?? "";
    const s = norm(script);
    const recommend = s === e || /[\\/]server[\\/]node[\\/]server\.cjs$/i.test(script) || /(cellar|dusk)-start\.cjs$/i.test(script);
    return { id: p.pm_id, name: p.name, status: p?.pm2_env?.status ?? "?", script, recommend };
  });
}

// 입력: "" → 없음, "a" → 추천만, "1,3" 또는 "1 3" → 그 번호들(목록 순번, 1부터)
function parsePick(input, rows) {
  const t = String(input ?? "").trim().toLowerCase();
  if (!t || t === "n" || t === "0") return [];
  if (t === "a") return rows.filter((r) => r.recommend);
  if (t === "all" || t === "*") return rows.slice();
  const out = [];
  for (const part of t.split(/[\s,]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > rows.length) return null;   // 잘못된 입력
    if (!out.includes(rows[n - 1])) out.push(rows[n - 1]);
  }
  return out;
}

function pickName(want, rows, deleting) {
  const taken = new Set(rows.filter((r) => !deleting.includes(r)).map((r) => r.name));
  if (!taken.has(want)) return want;
  for (let i = 2; ; i++) if (!taken.has(`${want}-${i}`)) return `${want}-${i}`;
}

// 부팅 시 자동 실행 명령 (pm2 startup이 안내하는 것과 같은 형태). 지원 안 되는 곳은 null + 이유
function startupPlan({ platform, env = {}, uid, nodeDir, pm2Bin = "pm2" }) {
  if (platform === "win32") return { skip: "윈도우는 pm2 startup을 지원하지 않아요. 작업 스케줄러에 'pm2 resurrect'를 로그온 시 실행으로 등록하거나 pm2-windows-startup을 쓰세요." };
  if (env.PREFIX && String(env.PREFIX).includes("com.termux")) return { skip: "Termux는 Termux:Boot 앱으로 자동 실행해요(~/.termux/boot/ 에 'pm2 resurrect' 스크립트)." };
  const init = platform === "darwin" ? "launchd" : "systemd";
  const user = env.USER || env.LOGNAME;
  const home = env.HOME;
  if (!user || !home) return { skip: "사용자 이름이나 홈 폴더를 알 수 없어요. 직접 'pm2 startup'을 실행해 주세요." };
  const args = [init, "-u", user, "--hp", home];
  if (uid === 0) return { cmd: pm2Bin, args: ["startup", ...args] };
  return { cmd: "sudo", args: ["env", `PATH=${nodeDir}:${env.PATH ?? ""}`, pm2Bin, "startup", ...args] };
}

module.exports = { findRisuEntry, risuRootOf, buildPlan, pm2Rows, parsePick, pickName, startupPlan };
if (require.main !== module) return;

// ── 실행 ──
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const YES = flag("--yes") || !process.stdin.isTTY;
const DRY = flag("--dry-run");
const say = (...a) => console.log(...a);
const step = (n, t) => say(`\n[${n}/5] ${t}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = "") => (YES ? Promise.resolve(def) : new Promise((r) => rl.question(q, (a) => r(a))));
const yes = async (q, def = true) => { const a = (await ask(`${q} ${def ? "(Y/n)" : "(y/N)"} `, def ? "y" : "n")).trim().toLowerCase(); return a ? a.startsWith("y") : def; };

function run(cmd, args, cwd) {
  say(`  $ ${cmd} ${args.join(" ")}${cwd ? `   (${cwd})` : ""}`);
  if (DRY) return 0;
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: WIN });
  return r.status ?? 1;
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: WIN });
  return r.status === 0 ? r.stdout : null;
}
const has = (cmd) => capture(cmd, ["--version"]) !== null || capture(cmd, ["-v"]) !== null;

async function waitHealth(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/cellar/health`); if (r.ok) return await r.json(); } catch { /* 아직 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

(async () => {
  const here = __dirname;
  const port = opt("--dusk-port", "6011");
  const launcher = path.join(here, "cellar-start.cjs");
  const dataDir = path.join(here, "dusk-data");
  say("Dusk Cellar 설치" + (DRY ? " (명령만 보기)" : ""));

  step(1, "리스 시작 파일 찾기");
  const entry = opt("--risu") ? path.resolve(opt("--risu")) : findRisuEntry(here);
  if (!entry || !fs.existsSync(entry)) {
    say("  리스 시작 파일(server/node/server.cjs)을 못 찾았어요.");
    say("  이 폴더를 리스 폴더 안에 클론했는지 확인하거나 --risu <경로>를 주세요.");
    process.exit(66);
  }
  const root = risuRootOf(entry);
  say(`  찾았어요: ${entry}`);
  say(`  리스 폴더: ${root}`);

  step(2, "리스 빌드");
  if (flag("--no-build")) say("  건너뜀 (--no-build)");
  else {
    const plan = buildPlan(root, has("pnpm"));
    if (!plan.length) say("  package.json이 없어 건너뛰어요 (이미 빌드된 배포본일 수 있어요).");
    else for (const [cmd, args] of plan) {
      const code = run(cmd, args, root);
      if (code !== 0) { say(`  빌드에 실패했어요 (코드 ${code}). 위 오류를 확인한 뒤 다시 실행하거나 --no-build로 건너뛰세요.`); process.exit(code); }
    }
  }

  const usePm2 = !flag("--no-pm2");
  if (usePm2 && !has("pm2")) {
    say("\n  pm2가 없어요.");
    if (await yes("  pm2를 설치할까요? (npm install -g pm2)")) {
      if (run("npm", ["install", "-g", "pm2"]) !== 0) { say("  pm2 설치에 실패했어요. 권한(관리자/sudo)을 확인하거나 --no-pm2로 바로 실행하세요."); process.exit(1); }
    } else {
      say("  pm2 없이 바로 실행해요. 창을 닫으면 리스와 Dusk가 함께 꺼져요.");
      rl.close();
      if (DRY) return say(`  $ node ${launcher} --risu ${entry} --dusk-port ${port} --data-dir ${dataDir}`);
      spawn(process.execPath, [launcher, "--risu", entry, "--dusk-port", port, "--data-dir", dataDir], { stdio: "inherit", cwd: root }).on("exit", (c) => process.exit(c ?? 0));
      return;
    }
  }

  let rows = [];
  let del = [];
  step(3, "pm2에 등록된 프로세스 정리");
  if (!usePm2) say("  건너뜀 (--no-pm2)");
  else {
    let list = [];
    try { list = JSON.parse(capture("pm2", ["jlist"]) ?? "[]"); } catch { list = []; }
    rows = pm2Rows(list, entry);
    if (!rows.length) say("  등록된 프로세스가 없어요.");
    else {
      say("  번호  이름                  상태      실행 파일");
      rows.forEach((r, i) => say(`  ${String(i + 1).padStart(3)}   ${String(r.name).padEnd(20).slice(0, 20)}  ${String(r.status).padEnd(8)}  ${r.script}${r.recommend ? "   ← 지우기 추천(리스를 직접 켜던 항목)" : ""}`));
      say("  이제 실행기가 리스를 대신 켜요. 리스를 직접 켜던 항목을 남기면 리스가 두 번 켜져 포트가 부딪혀요.");
      const hasRec = rows.some((r) => r.recommend);
      for (;;) {
        const a = await ask(`  지울 번호를 쉼표로 적어 주세요 (엔터 = 지우지 않음${hasRec ? ", a = 추천만" : ""}): `, flag("--yes") && hasRec ? "a" : "");
        const picked = parsePick(a, rows);
        if (picked) { del = picked; break; }
        if (YES) { del = []; break; }
        say("  번호를 다시 확인해 주세요.");
      }
      if (del.length && !(await yes(`  ${del.map((r) => r.name).join(", ")} 을(를) pm2에서 지울까요?`))) del = [];
      for (const r of del) run("pm2", ["delete", String(r.id)]);
      if (!del.length) say("  지우지 않았어요.");
    }
  }

  step(4, "리스 + Dusk Cellar 함께 실행");
  if (usePm2) {
    const name = pickName(opt("--name", "risu"), rows, del);
    const code = run("pm2", ["start", launcher, "--name", name, "--cwd", root, "--", "--risu", entry, "--dusk-port", port, "--data-dir", dataDir]);
    if (code !== 0) { say("  pm2 등록에 실패했어요."); process.exit(code); }
    run("pm2", ["save"]);
    say(`  pm2 이름: ${name}  (끄기: pm2 stop ${name} · 로그: pm2 logs ${name})`);
    // 부팅 시 자동 실행 (pm2 startup) — 관리자 암호를 물을 수 있어요
    const sp = startupPlan({ platform: process.platform, env: process.env, uid: process.getuid?.(), nodeDir: path.dirname(process.execPath), pm2Bin: (capture(WIN ? "where" : "which", ["pm2"]) ?? "pm2").split(/\r?\n/)[0].trim() || "pm2" });
    if (flag("--no-startup")) say("  부팅 시 자동 실행은 건너뜀 (--no-startup)");
    else if (sp.skip) say(`  부팅 시 자동 실행: ${sp.skip}`);
    else if (await yes("  서버를 다시 켜도 자동으로 켜지게 할까요? (pm2 startup, 관리자 암호를 물을 수 있어요)")) {
      if (run(sp.cmd, sp.args) === 0) { run("pm2", ["save"]); say("  부팅 시 자동 실행을 켰어요."); }
      else say("  자동 실행 등록에 실패했어요. 'pm2 startup'을 직접 실행해 안내된 명령을 따라 주세요.");
    }
  }

  step(5, "Dusk Cellar 확인");
  rl.close();
  if (DRY) return say("  (명령만 보기라 확인하지 않아요)");
  const h = await waitHealth(port);
  if (h) {
    say(`  응답해요: Dusk Cellar v${h.version} — http://127.0.0.1:${port}`);
    say(`  플러그인 연결 토큰: ${path.join(dataDir, "token.txt")} (다른 사람에게 보내지 마세요)`);
  } else say(`  아직 응답이 없어요. pm2 logs 로 오류를 확인해 주세요. (포트 ${port})`);
})().catch((e) => { say("설치 중 오류:", e?.message ?? e); process.exit(1); });
