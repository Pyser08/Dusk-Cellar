"use strict";
// Cellar 자체 업데이트(git clone으로 설치한 경우). 확인(check) → 적용(apply) → 되돌리기(rollback).
//   · 허용한 저장소(allow 정규식)에서만 받는다. 적용은 fast-forward만, 작업 폴더에 고친 파일이 있으면 거부한다.
//   · 적용 뒤 모든 .cjs를 새 프로세스에서 불러와 보고, 실패하면 이전 커밋으로 되돌린다.
//   · 재시작은 호출한 쪽(cellar-start.cjs)이 한다. 실행기(cellar-start.cjs)가 바뀌었으면 fullRestart=true(pm2 재시작 필요).
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { fail } = require("./risu-client.cjs");

const DEFAULT_ALLOW = /^(https:\/\/github\.com\/|git@github\.com:)Pyser08\/dusk-cellar(\.git)?\/?$/i;
const run = (cmd, args, cwd, timeout = 60000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
    if (err) return reject(Object.assign(new Error((stderr || err.message).trim().split("\n").slice(-2).join(" ")), { code: err.code }));
    resolve(String(stdout).trim());
  });
});

function createUpdate({ root, dataDir, allow = DEFAULT_ALLOW, log = () => {}, git = (args, t) => run("git", args, root, t), check }) {
  const stateFile = path.join(dataDir, "update.json");
  let busy = false;
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; } };
  // 새 코드 검사: 모든 .cjs는 문법만 확인(node --check)하고, 불러와도 아무 일도 안 하는 모듈만 실제로 불러 본다.
  // cellar-start.cjs·setup.cjs는 불러오는 순간 실행되므로(실행기를 켜 버림) 절대 require하지 않는다.
  const RUNS_ON_LOAD = new Set(["cellar-start.cjs", "setup.cjs"]);
  async function defaultCheck() {
    const files = fs.readdirSync(root).filter((n) => n.endsWith(".cjs"));
    for (const f of files) {
      const file = path.join(root, f);
      await run(process.execPath, ["--check", file], root, 20000).catch((e) => { throw new Error(`${f}: ${e.message}`); });
      if (RUNS_ON_LOAD.has(f)) continue;
      await run(process.execPath, ["-e", `require(${JSON.stringify(file)})`], root, 20000).catch((e) => { throw new Error(`${f}: ${e.message}`); });
    }
  }
  check = check ?? defaultCheck;
  async function prepare() {
    try { await git(["rev-parse", "--git-dir"]); } catch (e) { throw fail(501, e.code === "ENOENT" ? "git이 설치돼 있지 않아요" : "git으로 설치한 폴더가 아니라서 자동 업데이트를 쓸 수 없어요(직접 받아서 바꿔 주세요)"); }
    const url = await git(["remote", "get-url", "origin"]);
    if (!allow.test(url)) throw fail(403, `허용하지 않은 저장소예요: ${url}`);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") throw fail(409, "특정 커밋에 고정돼 있어서(detached) 업데이트할 수 없어요");
    return branch;
  }
  async function info() {
    const branch = await prepare();
    try { await git(["fetch", "--quiet", "origin", branch], 90000); } catch (e) { throw fail(424, `원격에서 받지 못했어요: ${e.message}`); }
    const head = await git(["rev-parse", "HEAD"]), latest = await git(["rev-parse", "FETCH_HEAD"]);
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).split("\n").filter(Boolean);
    const behind = head === latest ? 0 : Number(await git(["rev-list", "--count", `${head}..${latest}`]));
    const ahead = head === latest ? 0 : Number(await git(["rev-list", "--count", `${latest}..${head}`]));
    const commits = behind ? (await git(["log", "--format=%h %s", "-n", "20", `${head}..${latest}`])).split("\n") : [];
    return { branch, head: head.slice(0, 7), latest: latest.slice(0, 7), behind, ahead, commits, dirty, fullHead: head, fullLatest: latest };
  }
  const pub = ({ fullHead, fullLatest, ...r }) => r;

  async function checkUpdate() { const r = await info(); return { ok: true, ...pub(r), canApply: r.behind > 0 && r.ahead === 0 && !r.dirty.length, previous: readState().previous?.slice(0, 7) ?? null }; }

  async function apply() {
    if (busy) throw fail(409, "이미 업데이트 중이에요");
    busy = true;
    try {
      const r = await info();
      if (!r.behind) return { ok: true, updated: false, head: r.head };
      if (r.dirty.length) throw fail(409, `고친 파일이 있어서 업데이트하지 않았어요: ${r.dirty.slice(0, 5).join(", ")}`);
      if (r.ahead) throw fail(409, "이 폴더에만 있는 커밋이 있어서 업데이트하지 않았어요");
      const changed = (await git(["diff", "--name-only", r.fullHead, r.fullLatest])).split("\n").filter(Boolean);
      await git(["merge", "--ff-only", r.fullLatest]);
      try { await check(); }
      catch (e) { await git(["reset", "--hard", r.fullHead]); throw fail(500, `새 버전을 불러오지 못해서 이전 버전으로 되돌렸어요: ${e.message}`); }
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ previous: r.fullHead, at: new Date().toISOString(), to: r.fullLatest }));
      log(`업데이트: ${r.head} → ${r.latest}`);
      return { ok: true, updated: true, from: r.head, to: r.latest, changed, fullRestart: changed.includes("cellar-start.cjs") };
    } finally { busy = false; }
  }

  async function rollback() {
    if (busy) throw fail(409, "이미 업데이트 중이에요");
    busy = true;
    try {
      await prepare();
      const prev = readState().previous;
      if (!prev) throw fail(404, "되돌릴 이전 버전 기록이 없어요");
      if ((await git(["status", "--porcelain", "--untracked-files=no"])).trim()) throw fail(409, "고친 파일이 있어서 되돌리지 않았어요");
      const from = await git(["rev-parse", "HEAD"]);
      const changed = (await git(["diff", "--name-only", from, prev])).split("\n").filter(Boolean);
      await git(["reset", "--hard", prev]);
      fs.writeFileSync(stateFile, JSON.stringify({}));
      return { ok: true, to: prev.slice(0, 7), changed, fullRestart: changed.includes("cellar-start.cjs") };
    } finally { busy = false; }
  }
  return { check: checkUpdate, apply, rollback };
}
module.exports = { createUpdate, DEFAULT_ALLOW };
