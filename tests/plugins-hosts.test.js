const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { createPlugins } = require("../plugins.cjs");
const { BLOCK_MAGIC, LEGACY_PREFIX } = require("../risusave.cjs");
const { sha, tmp, plugin } = require("./helpers/fakerisubard.cjs");

const hex = Buffer.from("database/database.bin").toString("hex");
const blk = (type, comp, name, data) => { const d = comp ? zlib.gzipSync(Buffer.from(data)) : Buffer.from(data); const n = Buffer.from(name), h = Buffer.alloc(4); h.writeUInt32LE(d.length); return Buffer.concat([Buffer.from([type, comp, n.length]), n, h, d]); };
const dbFile = (plugins) => Buffer.concat([BLOCK_MAGIC, blk(0, 1, "config", "{}"), blk(9, 1, "plugins", JSON.stringify(plugins)), blk(2, 1, "chaA", '{"x":"캐릭터"}'), blk(1, 0, "root", '{"a":1}')]);
const codecLib = { pack: (o) => Buffer.from(JSON.stringify(o)), unpack: (b) => JSON.parse(Buffer.from(b).toString()), inflate: (b) => b, deflate: (b) => b, gunzip: (b) => b };
const legacy = (db) => Buffer.concat([LEGACY_PREFIX, Buffer.from([7]), Buffer.from(JSON.stringify(db))]);

function riuaiSetup(plugins = [plugin("a"), plugin("b")]) {
  const saveDir = tmp(), dataDir = tmp();
  fs.writeFileSync(path.join(saveDir, hex), dbFile(plugins));
  fs.writeFileSync(path.join(saveDir, Buffer.from("assets/x.png").toString("hex")), "img");
  return { saveDir, dataDir };
}

test("순정 리스AI: plugins 블록만 바꾸고 다른 블록은 바이트 그대로 둔다", async () => {
  const { saveDir, dataDir } = riuaiSetup();
  const before = fs.readFileSync(path.join(saveDir, hex));
  const p = createPlugins({ saveDir, dataDir, risuUrl: "http://127.0.0.1:1", verifyMs: 0, log: () => {} });
  const l = await p.list();
  assert.equal(l.host, "risuai"); assert.deepEqual(l.plugins.map((x) => x.name), ["a", "b"]);
  const r = await p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] });
  assert.equal(r.host, "risuai"); assert.equal(r.needsReload, true);
  const after = fs.readFileSync(path.join(saveDir, hex));
  const l2 = await p.list();
  assert.equal(l2.plugins[0].enabled, false); assert.equal(l2.plugins[1].enabled, true);
  // 캐릭터·root 블록 바이트 보존
  const tail = (b) => b.subarray(b.length - blk(2, 1, "chaA", '{"x":"캐릭터"}').length - blk(1, 0, "root", '{"a":1}').length);
  assert.equal(tail(before).length, tail(after).length);
  assert.ok(after.includes(blk(1, 0, "root", '{"a":1}')));
  assert.equal(fs.readdirSync(saveDir).some((n) => n.includes(".tmp")), false);
  // 스냅샷은 플러그인 목록만
  const snapDir = path.join(dataDir, "plugin-backups", fs.readdirSync(path.join(dataDir, "plugin-backups"))[0]);
  assert.ok(fs.existsSync(path.join(snapDir, "plugins.json.gz")));
});

test("순정 리스AI: 코드 고치기와 추가·삭제·순서", async () => {
  const { saveDir, dataDir } = riuaiSetup();
  const p = createPlugins({ saveDir, dataDir, risuUrl: "http://127.0.0.1:1", verifyMs: 0, log: () => {} });
  const g = await p.get({ name: "a" });
  await p.apply({ edits: [{ name: "a", expectSha: g.sha256, script: g.script + "//x\n" }] });
  assert.match((await p.get({ name: "a" })).script, /\/\/x/);
  await p.mutate({ ops: [{ op: "remove", name: "b" }] });
  assert.deepEqual((await p.list()).plugins.map((x) => x.name), ["a"]);
});

test("순정 리스AI: 쓴 뒤 브라우저가 옛 목록으로 덮어쓰면 overwritten으로 알린다", async () => {
  const { saveDir, dataDir } = riuaiSetup();
  const file = path.join(saveDir, hex), orig = fs.readFileSync(file);
  const p = createPlugins({ saveDir, dataDir, risuUrl: "http://127.0.0.1:1", verifyMs: 10, sleep: async () => fs.writeFileSync(file, orig), log: () => {} });
  const r = await p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] });
  assert.equal(r.overwritten, true); assert.equal(r.verified, false);
});

test("순정 리스AI: 덮어쓰이지 않으면 verified", async () => {
  const { saveDir, dataDir } = riuaiSetup();
  const p = createPlugins({ saveDir, dataDir, risuUrl: "http://127.0.0.1:1", verifyMs: 10, sleep: async () => {}, log: () => {} });
  const r = await p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] });
  assert.equal(r.verified, true); assert.equal(r.overwritten, false);
});

test("plugins 블록이 없거나 알 수 없는 형식이면 422", async () => {
  const saveDir = tmp(); fs.writeFileSync(path.join(saveDir, hex), Buffer.concat([BLOCK_MAGIC, blk(0, 1, "config", "{}")]));
  const p = createPlugins({ saveDir, dataDir: tmp(), risuUrl: "http://127.0.0.1:1", verifyMs: 0, log: () => {} });
  await assert.rejects(p.list(), (e) => e.status === 422 && /plugins 블록/.test(e.message));
  fs.writeFileSync(path.join(saveDir, hex), "garbage-garbage");
  await assert.rejects(p.list(), (e) => e.status === 422);
});

test("옛 형식 database.bin(raw): 주입한 코덱으로 plugins만 바꾸고 나머지 필드는 유지", async () => {
  const saveDir = tmp(); fs.writeFileSync(path.join(saveDir, hex), legacy({ theme: "dark", characters: [{ chaId: "c" }], plugins: [plugin("a")] }));
  const p = createPlugins({ saveDir, dataDir: tmp(), risuUrl: "http://127.0.0.1:1", verifyMs: 0, codecLib, log: () => {} });
  await p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] });
  const out = JSON.parse(fs.readFileSync(path.join(saveDir, hex)).subarray(LEGACY_PREFIX.length + 1).toString());
  assert.equal(out.theme, "dark"); assert.equal(out.characters[0].chaId, "c"); assert.equal(out.plugins[0].enabled, false);
});

// ── PocketRisu 흉내: /api/login /api/session /api/read /api/write ──
async function fakePocket(db0, opts = {}) {
  let db = db0, etag = '"e1"', n = 1; const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks), u = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: u.pathname, headers: req.headers });
      const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (u.pathname === "/api/login") return json(200, { status: "success", token: "TOKEN" });
      if (req.headers["risu-auth"] !== "TOKEN") return json(400, { error: "No auth header" });
      if (u.pathname === "/api/session") return json(200, { ok: true });
      if (u.pathname === "/api/read") { res.writeHead(200, { "x-db-etag": etag, "content-type": "application/octet-stream" }); return res.end(legacy(db)); }
      if (u.pathname === "/api/write") {
        if (!req.headers["x-session-id"]) return json(423, { error: "Session deactivated" });
        if (opts.conflict || (req.headers["x-if-match"] && req.headers["x-if-match"] !== etag)) return json(409, { error: "ETag mismatch", currentEtag: etag });
        db = JSON.parse(body.subarray(LEGACY_PREFIX.length + 1).toString()); etag = `"e${++n}"`; return json(200, { success: true });
      }
      json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, db: () => db, close: () => new Promise((r) => server.close(r)) };
}
const pocketSetup = () => { const saveDir = tmp(); fs.writeFileSync(path.join(saveDir, "risuai.db"), ""); fs.writeFileSync(path.join(saveDir, "__password"), "pw\n"); return saveDir; };

test("PocketRisu: /api/read로 읽고 x-if-match와 함께 /api/write로 plugins만 바꾼다", async (t) => {
  const f = await fakePocket({ theme: "dark", plugins: [plugin("a"), plugin("b")] }); t.after(() => f.close());
  const p = createPlugins({ saveDir: pocketSetup(), dataDir: tmp(), risuUrl: f.url, verifyMs: 0, codecLib, log: () => {} });
  assert.equal((await p.list()).host, "pocketrisu");
  const r = await p.mutate({ ops: [{ op: "set", name: "b", fields: { enabled: false } }] });
  assert.equal(r.host, "pocketrisu");
  assert.equal(f.db().theme, "dark"); assert.equal(f.db().plugins[1].enabled, false);
  const w = f.calls.find((c) => c.path === "/api/write");
  assert.equal(w.headers["x-if-match"], '"e1"'); assert.equal(w.headers["file-path"], hex); assert.ok(w.headers["x-session-id"]);
});

test("PocketRisu: etag가 어긋나면 409(conflict)로 알리고 아무것도 쓰지 않는다", async (t) => {
  const f = await fakePocket({ plugins: [plugin("a")] }, { conflict: true }); t.after(() => f.close());
  const p = createPlugins({ saveDir: pocketSetup(), dataDir: tmp(), risuUrl: f.url, verifyMs: 0, codecLib, log: () => {} });
  await assert.rejects(p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] }), (e) => e.status === 409 && e.extra?.conflict === true);
  assert.equal(f.db().plugins[0].enabled, true);
});

test("PocketRisu: 쓴 뒤 다시 읽어 확인한다", async (t) => {
  const f = await fakePocket({ plugins: [plugin("a")] }); t.after(() => f.close());
  const p = createPlugins({ saveDir: pocketSetup(), dataDir: tmp(), risuUrl: f.url, verifyMs: 5, sleep: async () => {}, codecLib, log: () => {} });
  const r = await p.mutate({ ops: [{ op: "set", name: "a", fields: { enabled: false } }] });
  assert.equal(r.verified, true); assert.equal(f.calls.filter((c) => c.path === "/api/read").length >= 2, true);
});
