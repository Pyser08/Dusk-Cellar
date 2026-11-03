import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAUNCHER = path.resolve("cellar-start.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => 20000 + Math.floor(Math.random() * 20000);

// 가짜 리스: server/node/server.cjs 자리에 두고, 작업 폴더를 파일로 남긴 뒤 계속 돈다
function fakeRisu() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "risu-"));
  fs.mkdirSync(path.join(root, "server", "node"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "node", "server.cjs"),
    `require("fs").writeFileSync("cwd.txt", process.cwd() + "|" + process.argv.slice(2).join(","));
     process.on("SIGTERM", () => process.exit(0));
     if (process.argv.includes("--die")) setTimeout(() => process.exit(3), 1500); else setInterval(() => {}, 1000);`);
  return root;
}
async function health(p, token) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${p}/cellar/health`, { headers: token ? { authorization: `Bearer ${token}` } : {} }); return await r.json(); } catch { await sleep(100); }
  }
  throw new Error("Dusk Cellar가 안 떴어요");
}
const exited = (child) => new Promise((r) => child.on("exit", (code) => r(code)));

test("리스와 Dusk Cellar가 함께 켜지고, 리스 폴더에서 리스를 돌린다", async () => {
  const root = fakeRisu(), p = port();
  const data = path.join(root, "dusk-data");
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", data, "--", "--port", "6001"], { stdio: "ignore" });
  try {
    const h = await health(p);
    assert.equal(h.ok, true); assert.equal(h.name, "dusk-cellar");
    assert.equal(h.auth, true, "같은 기기(127.0.0.1)는 토큰 없이 통과");
    const token = fs.readFileSync(path.join(data, "token.txt"), "utf8").trim();
    assert.equal((await health(p, token)).auth, true);
    const r = await fetch(`http://127.0.0.1:${p}/cellar/x`);
    assert.equal(r.status, 404, "인증은 통과, 없는 주소");
    assert.equal(fs.readFileSync(path.join(root, "cwd.txt"), "utf8"), `${fs.realpathSync(root)}|--port,6001`);
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("리스가 꺼지면 Dusk도 꺼지고 같은 종료 코드로 끝난다", async () => {
  const root = fakeRisu(), p = port();
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", path.join(root, "d"), "--", "--die"], { stdio: "ignore" });
  await health(p);
  assert.equal(await exited(ch), 3);
  await sleep(200);
  await assert.rejects(fetch(`http://127.0.0.1:${p}/cellar/health`));
});

test("리스 시작 파일이 없으면 알려 주고 끝난다", async () => {
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", "/없는/경로/server.cjs"], { stdio: "ignore" });
  assert.equal(await exited(ch), 66);
});

test("--require-token이면 같은 기기여도 토큰이 있어야 한다", async () => {
  const root = fakeRisu(), p = port();
  const data = path.join(root, "dusk-data");
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", data, "--require-token"], { stdio: "ignore" });
  try {
    assert.equal((await health(p)).auth, false);
    assert.equal((await fetch(`http://127.0.0.1:${p}/cellar/x`)).status, 401);
    const token = fs.readFileSync(path.join(data, "token.txt"), "utf8").trim();
    assert.equal((await health(p, token)).auth, true);
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("기억 저장소 주소: 쓰기·읽기·목록·충돌·재전송·삭제, 재시작 뒤에도 남는다", async () => {
  const root = fakeRisu(), p = port();
  const data = path.join(root, "dusk-data");
  const run = () => spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", data], { stdio: "ignore" });
  const base = `http://127.0.0.1:${p}/cellar/mem`;
  const call = async (method, url, body) => {
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  const K = "dusk.mem.v3.f.bot_chat";
  let ch = run();
  try {
    const h = await health(p);
    assert.deepEqual(h.features, ["mem", "update", "backup"]);
    assert.equal((await call("GET", `${base}/${K}`)).status, 404);
    const w1 = await call("PUT", `${base}/${K}`, { value: '{"n":1}', baseRev: 0, opId: "a1" });
    assert.equal(w1.json.rev, 1);
    assert.equal((await call("PUT", `${base}/${K}`, { value: '{"n":1}', baseRev: 0, opId: "a1" })).json.duplicate, true, "재전송은 한 번만");
    const bad = await call("PUT", `${base}/${K}`, { value: "x", baseRev: 0 });
    assert.equal(bad.status, 409); assert.equal(bad.json.conflict, true); assert.equal(bad.json.rev, 1);
    assert.equal((await call("GET", `${base}/${K}`)).json.value, '{"n":1}');
    const same = (await call("GET", `${base}/${K}?ifRev=1`)).json;
    assert.equal(same.same, true); assert.equal(same.value, undefined, "rev가 같으면 값을 빼고 보낸다");
    assert.equal((await call("GET", `${base}/${K}?ifRev=0`)).json.value, '{"n":1}');
    const b = await call("POST", `${base}/batch`, { ops: [{ op: "put", key: "dusk.mem.v3.index", value: "idx", baseRev: 0 }, { op: "put", key: K, value: "no", baseRev: 0 }] });
    assert.equal(b.json.results[0].ok, true); assert.equal(b.json.results[1].conflict, true);
    assert.deepEqual((await call("GET", `${base}?prefix=dusk.mem.v3.f.`)).json.items.map((x) => x.key), [K]);
    assert.equal((await call("PUT", `${base}/bad%20key`, { value: "x" })).status, 400);
    assert.equal((await call("POST", `${base}/batch`, { ops: "no" })).status, 400);
    ch.kill("SIGTERM"); await exited(ch);
    ch = run(); await health(p);
    assert.equal((await call("GET", `${base}/${K}`)).json.rev, 1, "다시 켜도 그대로");
    assert.equal((await call("DELETE", `${base}/${K}?baseRev=1`)).json.deleted, true);
    assert.equal((await call("GET", `${base}/${K}`)).status, 404);
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("--require-token이면 기억 저장소도 토큰 없이는 401", async () => {
  const root = fakeRisu(), p = port();
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", path.join(root, "d"), "--require-token"], { stdio: "ignore" });
  try {
    await health(p);
    assert.equal((await fetch(`http://127.0.0.1:${p}/cellar/mem`)).status, 401);
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("백업·복원(HTTP): 리스를 멈췄다가 세이브를 되돌리고 다시 켠다", async () => {
  const root = fakeRisu(), p = port();
  // 가짜 리스: 켜질 때마다 starts.txt에 한 줄, save/database.bin을 읽어 boot.txt에 남김
  fs.writeFileSync(path.join(root, "server", "node", "server.cjs"),
    `const fs=require("fs");fs.appendFileSync("starts.txt","x");try{fs.writeFileSync("boot.txt",fs.readFileSync("save/database.bin","utf8"))}catch{}
     process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);`);
  fs.mkdirSync(path.join(root, "save"), { recursive: true });
  fs.writeFileSync(path.join(root, "save", "database.bin"), "good");
  const data = path.join(root, "dusk-data");
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", data], { stdio: "ignore" });
  const api = `http://127.0.0.1:${p}/cellar/backup`;
  const post = async (b) => (await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
  try {
    const h = await health(p);
    assert.deepEqual(h.features, ["mem", "update", "backup"]);
    assert.equal((await post({ action: "create", label: "수동" })).ok, true);
    let list;
    for (let i = 0; i < 50; i++) { list = await (await fetch(api)).json(); if (list.job?.finishedAt) break; await sleep(100); }
    assert.equal(list.job.error, ""); assert.equal(list.items.length, 1);
    const id = list.items[0].id;
    fs.writeFileSync(path.join(root, "save", "database.bin"), "broken");
    fs.writeFileSync(path.join(root, "save", "extra.bin"), "x");
    assert.equal((await post({ action: "restore", id })).restarting, true);
    // 리스가 다시 켜질 때까지
    for (let i = 0; i < 80 && fs.readFileSync(path.join(root, "starts.txt"), "utf8").length < 2; i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(root, "starts.txt"), "utf8"), "xx", "리스가 한 번 다시 켜짐");
    assert.equal(fs.readFileSync(path.join(root, "boot.txt"), "utf8"), "good", "다시 켜질 때는 이미 복원된 세이브");
    assert.equal(fs.existsSync(path.join(root, "save", "extra.bin")), false);
    const after = await health(p);
    assert.equal(after.ok, true, "Cellar도 다시 켜짐");
    const items = (await (await fetch(api)).json()).items;
    assert.equal(items.length, 2); assert.equal(items[0].label, "복원 전 자동");
    assert.equal(ch.exitCode, null, "실행기는 계속 돈다");
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("/cellar/plugins: 기능 표시 + list·get·apply·충돌 응답이 실행기를 거쳐 동작한다", async () => {
  const { sha, plugin, setup, fakeRisubard } = (await import("./helpers/fakerisubard.cjs")).default;
  const root = fakeRisu(), p = port();
  const s = setup();
  const risu = await fakeRisubard(s.saveDir);
  const risuPort = new URL(risu.url).port;
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", s.dataDir, "--save-dir", s.saveDir, "--risu-port", risuPort], { stdio: "ignore" });
  const post = async (body) => { const r = await fetch(`http://127.0.0.1:${p}/cellar/plugins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  try {
    const h = await health(p);
    assert.ok(h.features.includes("plugins"), "RisuBard 세이브 폴더면 plugins 기능을 알린다");
    const l = await post({ action: "list" });
    assert.equal(l.status, 200); assert.equal(l.json.plugins.length, 2);
    const g = await post({ action: "get", name: "dusk_atelier" });
    assert.equal(g.json.script, plugin("dusk_atelier").script);
    const bad = await post({ action: "apply", edits: [{ name: "dusk_atelier", expectSha: sha("옛 코드"), script: "//@name dusk_atelier\nx\n" }] });
    assert.equal(bad.status, 409); assert.equal(bad.json.conflict, true); assert.equal(bad.json.currentSha, sha(plugin("dusk_atelier").script));
    const script = "//@name dusk_atelier\n//@api 3.0\nconsole.log('새 코드');\n";
    const ok = await post({ action: "apply", edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script }] });
    assert.equal(ok.status, 200); assert.equal(ok.json.adopted, true); assert.equal(ok.json.needsReload, true);
    assert.equal(s.read("settings/app.json").plugins[0].script, script);
    assert.equal((await post({ action: "nope" })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${p}/cellar/plugins`)).status, 404, "GET은 없다(POST만)");
  } finally { ch.kill("SIGTERM"); await exited(ch); await risu.close(); }
});

test("세이브 폴더를 알아볼 수 없으면 plugins 기능을 알리지 않고, 쓰려 하면 501", async () => {
  const root = fakeRisu(), p = port(), save = fs.mkdtempSync(path.join(os.tmpdir(), "save-"));
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", path.join(root, "d"), "--save-dir", save], { stdio: "ignore" });
  try {
    const h = await health(p);
    assert.ok(!h.features.includes("plugins"));
    const r = await fetch(`http://127.0.0.1:${p}/cellar/plugins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list" }) });
    const j = await r.json();
    assert.equal(r.status, 501); assert.equal(j.host, "unknown");
  } finally { ch.kill("SIGTERM"); await exited(ch); }
});

test("실행기와의 연결이 끊기면 Dusk Cellar 서버는 스스로 끝난다(고아로 포트를 붙잡지 않음)", async () => {
  const root = fakeRisu(), p = port();
  const ch = spawn(process.execPath, [LAUNCHER, "--role-server", "--dusk-port", String(p), "--data-dir", path.join(root, "d")], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await health(p);
    ch.disconnect();
    const code = await new Promise((res) => { const t = setTimeout(() => res("안 끝남"), 4000); ch.once("exit", (c) => { clearTimeout(t); res(c); }); });
    assert.equal(code, 0);
  } finally { ch.kill("SIGKILL"); }
});

test("같은 데이터 폴더의 이전 Cellar가 포트를 잡고 있으면 끄고 이어받는다", async () => {
  const root = fakeRisu(), p = port(), d = path.join(root, "d");
  const run = () => spawn(process.execPath, [LAUNCHER, "--role-server", "--dusk-port", String(p), "--data-dir", d], { stdio: "ignore" });
  const a = run();
  try {
    const h1 = await health(p);
    const b = run();
    try {
      const code = await new Promise((res) => { const t = setTimeout(() => res("안 끝남"), 6000); a.once("exit", (c, sig) => { clearTimeout(t); res(sig ?? c); }); });
      assert.ok(code === "SIGTERM" || code === 0, String(code));
      await new Promise((r) => setTimeout(r, 500));
      const h2 = await health(p);
      assert.notEqual(h2.pid, h1.pid);
      assert.equal(h2.pid, b.pid);
    } finally { b.kill("SIGKILL"); }
  } finally { a.kill("SIGKILL"); }
});

test("다른 데이터 폴더의 Cellar가 잡은 포트는 건드리지 않고 78로 끝난다", async () => {
  const root = fakeRisu(), p = port();
  const a = spawn(process.execPath, [LAUNCHER, "--role-server", "--dusk-port", String(p), "--data-dir", path.join(root, "d1")], { stdio: "ignore" });
  try {
    await health(p);
    const b = spawn(process.execPath, [LAUNCHER, "--role-server", "--dusk-port", String(p), "--data-dir", path.join(root, "d2")], { stdio: "ignore" });
    const code = await new Promise((res) => { const t = setTimeout(() => res("안 끝남"), 6000); b.once("exit", (c) => { clearTimeout(t); res(c); }); });
    assert.equal(code, 78);
    assert.equal((await health(p)).pid, a.pid);
  } finally { a.kill("SIGKILL"); }
});

test("node -e 로 불러오면 실행기를 켜지 않고 바로 오류로 끝난다(프로세스 증식 방지)", async () => {
  const root = fakeRisu(), p = port();
  const ch = spawn(process.execPath, ["-e", `require(${JSON.stringify(LAUNCHER)})`, path.join(root, "server/node/server.cjs"), "--dusk-port", String(p)], { stdio: "ignore" });
  const code = await new Promise((res) => { const t = setTimeout(() => res("안 끝남"), 5000); ch.once("exit", (c) => { clearTimeout(t); res(c); }); });
  if (code === "안 끝남") ch.kill("SIGKILL");
  assert.notEqual(code, "안 끝남"); assert.notEqual(code, 0);
  const r = await fetch(`http://127.0.0.1:${p}/cellar/health`).then(() => "떠 있음", () => "안 떠 있음");
  assert.equal(r, "안 떠 있음");
});

test("실행기가 띄운 프로세스 안에서는 실행기가 또 켜지지 않는다", async () => {
  const root = fakeRisu(), p = port();
  const ch = spawn(process.execPath, [LAUNCHER, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p)], { stdio: "ignore", env: { ...process.env, DUSK_CELLAR_LAUNCHER: "1" } });
  const code = await new Promise((res) => { const t = setTimeout(() => res("안 끝남"), 5000); ch.once("exit", (c) => { clearTimeout(t); res(c); }); });
  if (code === "안 끝남") ch.kill("SIGKILL");
  assert.equal(code, 1);
});

test("ESM import로 불러와도(pm2 방식) 정상적으로 실행기가 켜진다", async () => {
  const root = fakeRisu(), p = port();
  const loader = path.join(root, "esm-loader.mjs");
  fs.writeFileSync(loader, `import(${JSON.stringify(LAUNCHER)}).catch((e) => { console.error(e); process.exit(9); });\n`);
  const ch = spawn(process.execPath, [loader, "--risu", path.join(root, "server/node/server.cjs"), "--dusk-port", String(p), "--data-dir", path.join(root, "d")], { stdio: "ignore" });
  try { await health(p); } finally { ch.kill("SIGTERM"); await exited(ch); }
});
