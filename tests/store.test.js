const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, SNAP_KEEP } = require("../store.cjs");

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dusk-store-")));
const K = "dusk.mem.v3.f.bot1_chat1";

test("쓰고 읽고 지운다. rev는 쓸 때마다 오른다", () => {
  const s = createStore({ dir: tmp() });
  assert.equal(s.get(K), null);
  assert.equal(s.put(K, '{"a":1}').rev, 1);
  assert.equal(s.put(K, '{"a":2}').rev, 2);
  const g = s.get(K);
  assert.equal(g.value, '{"a":2}'); assert.equal(g.rev, 2);
  assert.deepEqual(s.del(K), { ok: true, key: K, deleted: true });
  assert.equal(s.get(K), null);
  assert.equal(s.del(K).deleted, false, "없는 키 삭제는 그냥 성공");
});

test("값은 줄바꿈·한글·따옴표가 있어도 그대로 돌려준다", () => {
  const s = createStore({ dir: tmp() });
  const v = '{"t":"안녕\\n"}\n둘째 줄 "x"\n';
  s.put(K, v);
  assert.equal(s.get(K).value, v);
});

test("baseRev가 다르면 충돌, 같거나 0(없어야 함)이면 통과", () => {
  const s = createStore({ dir: tmp() });
  assert.equal(s.put(K, "a", { baseRev: 0 }).rev, 1);
  assert.throws(() => s.put(K, "b", { baseRev: 0 }), (e) => e.status === 409 && e.conflict && e.rev === 1);
  assert.equal(s.put(K, "b", { baseRev: 1 }).rev, 2);
  assert.throws(() => s.del(K, { baseRev: 1 }), (e) => e.status === 409);
  assert.equal(s.get(K).value, "b", "충돌한 쓰기는 반영되지 않는다");
  assert.equal(s.del(K, { baseRev: 2 }).deleted, true);
});

test("같은 opId를 다시 보내도 한 번만 반영된다", () => {
  const s = createStore({ dir: tmp() });
  const a = s.put(K, "a", { opId: "op-1" });
  const again = s.put(K, "a", { opId: "op-1" });
  assert.equal(again.duplicate, true); assert.equal(again.rev, a.rev);
  assert.equal(s.get(K).rev, 1);
  assert.equal(s.put(K, "b", { opId: "op-2" }).rev, 2);
  assert.equal(s.put(K, "x", { opId: "op-1" }).duplicate, true, "예전 opId도 기억");
  assert.equal(s.get(K).value, "b");
});

test("다시 켜도 목록·rev·opId가 남아 있다", () => {
  const dir = tmp();
  const s1 = createStore({ dir });
  s1.put(K, "a", { opId: "op-1" }); s1.put("dusk.mem.v3.index", "idx");
  const s2 = createStore({ dir });
  assert.deepEqual(s2.list().map((x) => x.key), ["dusk.mem.v3.f.bot1_chat1", "dusk.mem.v3.index"]);
  assert.equal(s2.get(K).value, "a");
  assert.equal(s2.put(K, "a", { opId: "op-1" }).duplicate, true);
  assert.deepEqual(s2.list("dusk.mem.v3.f.").map((x) => x.key), [K]);
});

test("이상한 키·값은 400/413으로 거절한다", () => {
  const s = createStore({ dir: tmp() });
  for (const bad of ["../etc/passwd", "x", "dusk.mem.", "dusk.mem.a b", "dusk.mem." + "a".repeat(201)]) assert.throws(() => s.put(bad, "v"), (e) => e.status === 400, bad);
  assert.throws(() => s.put(K, { a: 1 }), (e) => e.status === 400);
  assert.throws(() => s.put(K, "v", { baseRev: -1 }), (e) => e.status === 400);
  assert.throws(() => s.put(K, "v", { baseRev: "abc" }), (e) => e.status === 400);
  assert.throws(() => s.put(K, "x".repeat(16 * 1024 * 1024 + 1)), (e) => e.status === 413);
});

test("batch: 일부가 실패해도 나머지는 반영되고 결과는 같은 순서", () => {
  const s = createStore({ dir: tmp() });
  s.put("dusk.mem.old", "o");
  const r = s.batch([
    { op: "put", key: "dusk.mem.a", value: "1", baseRev: 0 },
    { op: "put", key: "dusk.mem.old", value: "x", baseRev: 0 },
    { op: "del", key: "dusk.mem.old", baseRev: 1 },
    { op: "zap", key: "dusk.mem.a" },
  ]);
  assert.equal(r[0].ok, true); assert.equal(r[0].rev, 1);
  assert.equal(r[1].ok, false); assert.equal(r[1].conflict, true); assert.equal(r[1].rev, 1);
  assert.equal(r[2].deleted, true);
  assert.equal(r[3].status, 400);
  assert.equal(s.get("dusk.mem.a").value, "1");
  assert.throws(() => s.batch("no"), (e) => e.status === 400);
});

test("하루 첫 쓰기 전에 스냅샷을 남기고 7일치만 둔다", () => {
  const dir = tmp();
  let t = new Date("2026-11-01T01:00:00Z");
  const s = createStore({ dir, now: () => t });
  s.put(K, "v1");                               // 아직 비어 있어서 스냅샷 없음
  assert.equal(fs.existsSync(path.join(dir, "snapshots")), false);
  s.put(K, "v2");                               // 같은 날 두 번째 쓰기: 첫 쓰기 때 비어 있었으니 지금 한 번 남긴다
  const day1 = path.join(dir, "snapshots", "2026-11-01");
  assert.equal(fs.existsSync(day1), true);
  s.put(K, "v3");
  assert.equal(fs.readdirSync(path.join(dir, "snapshots")).length, 1, "같은 날은 한 번만");
  for (let d = 2; d <= 10; d++) { t = new Date(`2026-11-${String(d).padStart(2, "0")}T01:00:00Z`); s.put(K, "v" + d); }
  const days = fs.readdirSync(path.join(dir, "snapshots")).sort();
  assert.equal(days.length, SNAP_KEEP);
  assert.equal(days[days.length - 1], "2026-11-10");
  // 스냅샷은 그날 첫 쓰기 '직전' 상태: 11/10 스냅샷에는 v9가 들어 있다
  const copy = tmp();
  fs.cpSync(path.join(dir, "snapshots", "2026-11-10"), path.join(copy, "mem"), { recursive: true });
  assert.equal(createStore({ dir: copy }).get(K).value, "v9");
  assert.equal(createStore({ dir }).get(K).value, "v10");
});
