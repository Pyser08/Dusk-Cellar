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
    assert.deepEqual(h.features, ["mem"]);
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
