const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createAssets } = require("../assets.cjs");
const { setup, tmp, fakeRisubard } = require("./helpers/fakerisubard.cjs");

const asset = (text, ext = "png") => { const buf = Buffer.from(text); const key = `assets/${crypto.createHash("sha256").update(buf).digest("hex")}.${ext}`; return { key, value: buf.toString("base64"), buf }; };
const hex = (k) => Buffer.from(k).toString("hex");

test("순정 리스AI: 세이브 폴더에 hex 이름 파일로 직접 쓰고, 이미 있으면 missing에서 빠진다", async () => {
  const saveDir = tmp(); fs.writeFileSync(path.join(saveDir, hex("database/database.bin")), "x");
  const a = createAssets({ saveDir, host: "risuai", risuUrl: "http://127.0.0.1:1" });
  const x = asset("one"), y = asset("two", "mp3");
  assert.deepEqual((await a.missing({ keys: [x.key, y.key, x.key] })).missing, [x.key, y.key]);
  assert.deepEqual(await a.put({ entries: [x, y] }), { written: 2, sink: "direct" });
  assert.equal(fs.readFileSync(path.join(saveDir, hex(x.key)), "utf8"), "one");
  assert.deepEqual((await a.missing({ keys: [x.key, y.key] })).missing, []);
  assert.equal(fs.readdirSync(saveDir).some((n) => n.endsWith(".tmp")), false);
});

test("해시가 안 맞거나 키 모양이 틀리면 거부한다", async () => {
  const a = createAssets({ saveDir: tmp(), host: "risuai", risuUrl: "http://127.0.0.1:1" });
  const x = asset("one");
  await assert.rejects(a.put({ entries: [{ key: x.key, value: Buffer.from("other").toString("base64") }] }), (e) => e.status === 400);
  await assert.rejects(a.put({ entries: [{ key: "../../etc/passwd", value: "" }] }), (e) => e.status === 400);
  await assert.rejects(a.missing({ keys: ["database/database.bin"] }), (e) => e.status === 400);
});

test("알 수 없는 호스트는 501", async () => {
  const a = createAssets({ saveDir: tmp(), host: "unknown", risuUrl: "http://127.0.0.1:1" });
  assert.equal(a.status().ok, false);
  await assert.rejects(a.put({ entries: [asset("a")] }), (e) => e.status === 501);
});

for (const host of ["risubard", "pocketrisu"]) test(`${host}: bulk-write로 묶어 보내고 목록으로 없는 것만 알려 준다`, async () => {
  const s = setup(); const risu = await fakeRisubard(s.saveDir);
  try {
    const a = createAssets({ saveDir: s.saveDir, host, risuUrl: risu.url });
    const list = Array.from({ length: 120 }, (_, i) => asset(`item-${i}`));
    assert.equal((await a.missing({ keys: list.map((e) => e.key) })).missing.length, 120);
    assert.deepEqual(await a.put({ entries: list.slice(0, 100) }), { written: 100, sink: "bulk" });
    assert.equal(risu.calls.filter((c) => c.path === "/api/assets/bulk-write").length, 2);   // 50개씩
    assert.deepEqual((await a.missing({ keys: list.map((e) => e.key) })).missing, list.slice(100).map((e) => e.key));
  } finally { await risu.close(); }
});

test("RisuBard: asset-store 파일이 이미 있으면 missing에서 빠진다", async () => {
  const s = setup(); const risu = await fakeRisubard(s.saveDir);
  try {
    const x = asset("stored"), d = x.key.slice(7, 71);
    fs.mkdirSync(path.join(s.saveDir, "asset-store", d.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(s.saveDir, "asset-store", d.slice(0, 2), `${d}.png`), "stored");
    const a = createAssets({ saveDir: s.saveDir, host: "risubard", risuUrl: risu.url });
    assert.deepEqual((await a.missing({ keys: [x.key] })).missing, []);
  } finally { await risu.close(); }
});

test("bulk-write가 실패하면 424로 알린다", async () => {
  const s = setup(); const risu = await fakeRisubard(s.saveDir, { bulkStatus: 500 });
  try {
    const a = createAssets({ saveDir: s.saveDir, host: "risubard", risuUrl: risu.url });
    await assert.rejects(a.put({ entries: [asset("a")] }), (e) => e.status === 424);
  } finally { await risu.close(); }
});
