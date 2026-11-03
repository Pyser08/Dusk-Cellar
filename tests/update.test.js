const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createUpdate, DEFAULT_ALLOW } = require("../update.cjs");
const { tmp } = require("./helpers/fakerisubard.cjs");

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();
function repos() {
  const base = tmp(), origin = path.join(base, "origin.git"), a = path.join(base, "a"), b = path.join(base, "b");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, a]); fs.writeFileSync(path.join(a, "x.cjs"), "module.exports=1;\n"); g(a, "add", "."); g(a, "commit", "-qm", "첫 커밋"); g(a, "branch", "-M", "main"); g(a, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, b]);
  const publish = (name, text, msg) => { fs.writeFileSync(path.join(a, name), text); g(a, "add", "."); g(a, "commit", "-qm", msg); g(a, "push", "-q", "origin", "main"); };
  return { a, b, origin, publish, dataDir: tmp() };
}
const mk = (r, o = {}) => createUpdate({ root: r.b, dataDir: r.dataDir, allow: /./, check: async () => {}, ...o });

test("새 커밋이 없으면 behind 0, 있으면 목록과 canApply", async () => {
  const r = repos(), u = mk(r);
  assert.equal((await u.check()).behind, 0);
  r.publish("y.cjs", "module.exports=2;\n", "둘째");
  const c = await u.check();
  assert.equal(c.behind, 1); assert.equal(c.canApply, true); assert.match(c.commits[0], /둘째/);
});

test("apply: 가져온 뒤 바뀐 파일을 알려 주고, rollback으로 되돌린다", async () => {
  const r = repos(), u = mk(r);
  r.publish("y.cjs", "module.exports=2;\n", "둘째");
  const a = await u.apply();
  assert.equal(a.updated, true); assert.deepEqual(a.changed, ["y.cjs"]); assert.equal(a.fullRestart, false);
  assert.ok(fs.existsSync(path.join(r.b, "y.cjs")));
  assert.equal((await u.apply()).updated, false);
  const rb = await u.rollback();
  assert.equal(rb.ok, true); assert.ok(!fs.existsSync(path.join(r.b, "y.cjs")));
  await assert.rejects(u.rollback(), (e) => e.status === 404);
});

test("실행기(cellar-start.cjs)가 바뀌면 fullRestart", async () => {
  const r = repos(), u = mk(r);
  r.publish("cellar-start.cjs", "//x\n", "실행기");
  assert.equal((await u.apply()).fullRestart, true);
});

test("불러오기 검사에 실패하면 이전 커밋으로 되돌린다", async () => {
  const r = repos(), u = mk(r, { check: async () => { throw new Error("y.cjs: 문법 오류"); } });
  r.publish("y.cjs", "module.exports=2;\n", "둘째");
  const before = g(r.b, "rev-parse", "HEAD");
  await assert.rejects(u.apply(), (e) => e.status === 500 && /되돌렸어요/.test(e.message));
  assert.equal(g(r.b, "rev-parse", "HEAD"), before);
});

test("고친 파일이 있으면 거부한다", async () => {
  const r = repos(), u = mk(r);
  r.publish("y.cjs", "module.exports=2;\n", "둘째");
  fs.appendFileSync(path.join(r.b, "x.cjs"), "//local\n");
  await assert.rejects(u.apply(), (e) => e.status === 409);
  assert.equal((await u.check()).canApply, false);
});

test("허용하지 않은 저장소와 git이 아닌 폴더는 거부한다", async () => {
  const r = repos();
  await assert.rejects(createUpdate({ root: r.b, dataDir: r.dataDir }).check(), (e) => e.status === 403);   // 기본 허용 목록
  assert.ok(DEFAULT_ALLOW.test("https://github.com/Pyser08/dusk-cellar") && DEFAULT_ALLOW.test("https://github.com/Pyser08/Dusk-Cellar.git"));
  assert.ok(!DEFAULT_ALLOW.test("https://github.com/evil/dusk-cellar"));
  await assert.rejects(createUpdate({ root: tmp(), dataDir: r.dataDir, allow: /./ }).check(), (e) => e.status === 501);
});

test("기본 새 코드 검사는 불러오면 실행되는 파일(cellar-start.cjs)을 실행하지 않는다", async () => {
  const r = repos(), marker = path.join(r.b, "RAN");
  fs.writeFileSync(path.join(r.a, "cellar-start.cjs"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`); g(r.a, "add", "."); g(r.a, "commit", "-qm", "실행기"); g(r.a, "push", "-q", "origin", "main");
  const u = createUpdate({ root: r.b, dataDir: r.dataDir, allow: /./ });
  const out = await u.apply();
  assert.equal(out.updated, true);
  assert.equal(fs.existsSync(marker), false);
});

test("기본 새 코드 검사는 문법 오류를 잡아 이전 버전으로 되돌린다", async () => {
  const r = repos(), u = createUpdate({ root: r.b, dataDir: r.dataDir, allow: /./ });
  r.publish("bad.cjs", "const = ;\n", "깨진 코드");
  const before = g(r.b, "rev-parse", "HEAD");
  await assert.rejects(u.apply(), (e) => e.status === 500 && /bad\.cjs/.test(e.message));
  assert.equal(g(r.b, "rev-parse", "HEAD"), before);
});
