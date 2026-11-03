const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBackups, scan } = require("../backup.cjs");

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dusk-bk-")));
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = (p) => fs.readFileSync(p, "utf8");
function world() {
  const root = tmp(), save = path.join(root, "save"), data = path.join(root, "dusk-data");
  put(path.join(save, "database.bin"), "db-1");
  put(path.join(save, "kv", "manifest.json"), '{"a":1}');
  put(path.join(save, "kv", "objects", "ab", "abc"), "IMG".repeat(1000));
  put(path.join(data, "mem", "x.mem"), "mem-1");
  let t = new Date("2026-11-03T01:00:00Z");
  const b = createBackups({ dataDir: data, saveDir: save, keep: 3, now: () => t });
  return { root, save, data, b, later: (s) => { t = new Date(t.getTime() + s * 1000); } };
}

test("첫 백업은 전부 복사, 다음 백업은 바뀐 파일만 복사하고 나머지는 하드링크", async () => {
  const w = world();
  const a = await w.b.create();
  assert.equal(a.files, 4); assert.equal(a.copied, 4); assert.equal(a.linked, 0);
  put(path.join(w.save, "database.bin"), "db-2-longer");
  w.later(60);
  const b2 = await w.b.create({ label: "두 번째" });
  assert.equal(b2.copied, 1); assert.equal(b2.linked, 3);
  const img1 = path.join(w.data, "backups", a.id, "save", "kv", "objects", "ab", "abc");
  const img2 = path.join(w.data, "backups", b2.id, "save", "kv", "objects", "ab", "abc");
  assert.equal(fs.statSync(img1).ino, fs.statSync(img2).ino, "같은 파일을 공유");
  assert.equal(read(path.join(w.data, "backups", a.id, "save", "database.bin")), "db-1", "예전 백업은 그대로");
  const list = w.b.list();
  assert.deepEqual(list.map((x) => x.id), [b2.id, a.id]);
  assert.equal(list[0].label, "두 번째");
});

test("백업은 리스 파일과 링크하지 않는다(리스가 제자리에서 고쳐 써도 백업은 안전)", async () => {
  const w = world();
  const a = await w.b.create();
  fs.writeFileSync(path.join(w.save, "kv", "manifest.json"), '{"a":2}');   // 같은 inode에 덮어쓰기
  assert.equal(read(path.join(w.data, "backups", a.id, "save", "kv", "manifest.json")), '{"a":1}');
});

test("복원: 다른 파일만 바꾸고, 백업에 없는 파일은 지우고, 기억도 되돌린다", async () => {
  const w = world();
  const a = await w.b.create();
  put(path.join(w.save, "database.bin"), "db-broken");
  put(path.join(w.save, "kv", "objects", "zz", "new"), "N");
  put(path.join(w.data, "mem", "x.mem"), "mem-2");
  fs.rmSync(path.join(w.save, "kv", "manifest.json"));
  const r = await w.b.restore(a.id);
  assert.equal(read(path.join(w.save, "database.bin")), "db-1");
  assert.equal(read(path.join(w.save, "kv", "manifest.json")), '{"a":1}');
  assert.equal(fs.existsSync(path.join(w.save, "kv", "objects", "zz")), false, "새로 생긴 파일·빈 폴더는 사라짐");
  assert.equal(read(path.join(w.data, "mem", "x.mem")), "mem-1");
  assert.equal(r.removed, 1); assert.equal(r.replaced, 3);
  // 복원 후에는 파일 정보가 백업과 같아서, 다음 백업은 전부 링크
  w.later(60);
  const again = await w.b.create();
  assert.equal(again.copied, 0);
  // 복원한 파일을 고쳐도 백업은 그대로(복사로 되돌렸기 때문)
  fs.writeFileSync(path.join(w.save, "database.bin"), "edit");
  assert.equal(read(path.join(w.data, "backups", a.id, "save", "database.bin")), "db-1");
});

test("보관 개수를 넘으면 오래된 백업부터 지운다", async () => {
  const w = world();
  const made = [];
  for (let i = 0; i < 5; i++) { put(path.join(w.save, "database.bin"), "db-" + i); made.push((await w.b.create()).id); w.later(60); }
  assert.deepEqual(w.b.list().map((x) => x.id), made.slice(2).reverse());
  assert.equal(read(path.join(w.data, "backups", made[4], "save", "kv", "objects", "ab", "abc")), "IMG".repeat(1000), "링크 원본을 지워도 남은 백업은 멀쩡");
});

test("작업으로 돌리면 상태를 볼 수 있고, 동시에 두 번은 안 된다", async () => {
  const w = world();
  const j = w.b.startCreate({});
  assert.throws(() => w.b.startCreate({}), (e) => e.status === 409);
  while (!j.finishedAt) await new Promise((r) => setTimeout(r, 10));
  assert.equal(j.error, ""); assert.equal(j.result.files, 4); assert.equal(w.b.status().done, 4);
});

test("잘못된 이름·없는 백업은 거절", async () => {
  const w = world();
  await assert.rejects(w.b.restore("../../etc"), (e) => e.status === 400);
  await assert.rejects(w.b.restore("20260101-000000"), (e) => e.status === 404);
  await assert.rejects(w.b.remove("x"), (e) => e.status === 404);
});

test("scan: 파일만, 크기와 수정 시각", async () => {
  const w = world();
  const s = await scan(w.save);
  assert.deepEqual(Object.keys(s).sort(), ["database.bin", "kv/manifest.json", "kv/objects/ab/abc"]);
  assert.equal(s["database.bin"][0], 4);
  assert.deepEqual(await scan(path.join(w.root, "없음")), {});
});

test("SQLite(WAL)는 온라인 백업으로 일관되게 담고, -wal·-shm은 빼고, 복원하면 지운다", async () => {
  const w = world();
  const { DatabaseSync } = require("node:sqlite");
  const dbFile = path.join(w.save, "risuai.db");
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);");
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("a", "1");     // WAL에만 있고 본 파일에는 아직 없음
  assert.ok(fs.existsSync(dbFile + "-wal"));
  const a = await w.b.create();
  const snap = path.join(w.data, "backups", a.id, "save");
  assert.equal(fs.existsSync(path.join(snap, "risuai.db-wal")), false);
  const copy = new DatabaseSync(path.join(snap, "risuai.db"), { readOnly: true });
  assert.equal(copy.prepare("SELECT v FROM kv WHERE k='a'").get().v, "1", "WAL에만 있던 내용도 담김");
  copy.close();
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("b", "2");
  db.close();
  await w.b.restore(a.id);
  assert.equal(fs.existsSync(dbFile + "-wal"), false);
  const back = new DatabaseSync(dbFile, { readOnly: true });
  assert.deepEqual(back.prepare("SELECT k FROM kv ORDER BY k").all().map((r) => r.k), ["a"]);
  back.close();
});

test("RisuBard 잠금 폴더는 백업하지도 복원으로 건드리지도 않는다", async () => {
  const w = world();
  put(path.join(w.save, ".risubard-server.lock", "owner.json"), '{"pid":1}');
  const a = await w.b.create();
  assert.equal(fs.existsSync(path.join(w.data, "backups", a.id, "save", ".risubard-server.lock")), false);
  put(path.join(w.save, ".risubard-server.lock", "owner.json"), '{"pid":2}');
  await w.b.restore(a.id);
  assert.equal(read(path.join(w.save, ".risubard-server.lock", "owner.json")), '{"pid":2}');
});

test("세이브가 비었거나 없으면 백업하지 않는다", async () => {
  const w = world();
  fs.rmSync(w.save, { recursive: true });
  await assert.rejects(() => w.b.create(), /세이브/);
  fs.mkdirSync(w.save);
  await assert.rejects(() => w.b.create(), /하나도 없/);
  assert.equal(w.b.list().length, 0);
});

test("verify: 정상 백업은 통과, 파일이 빠지거나 크기가 다르면 거부", async () => {
  const w = world();
  const a = await w.b.create();
  await w.b.verify(a.id);
  const f = path.join(w.data, "backups", a.id, "save", "kv", "manifest.json");
  fs.writeFileSync(f, "x");
  await assert.rejects(() => w.b.verify(a.id));
  fs.rmSync(f);
  await assert.rejects(() => w.b.verify(a.id));
});

test("복원: 없던 파일은 지우고 바뀐 파일은 되돌린다(순서: 덮어쓰기 후 삭제)", async () => {
  const w = world();
  const a = await w.b.create();
  put(path.join(w.save, "database.bin"), "broken!!");
  put(path.join(w.save, "extra.bin"), "x");
  await w.b.restore(a.id);
  assert.equal(read(path.join(w.save, "database.bin")), "db-1");
  assert.equal(fs.existsSync(path.join(w.save, "extra.bin")), false);
});

test("오래 남은 .tmp 백업 폴더는 새 백업 때 정리", async () => {
  const w = world();
  const stale = path.join(w.data, "backups", "old.tmp");
  put(path.join(stale, "x"), "1");
  await w.b.create();
  assert.equal(fs.existsSync(stale), false);
});
