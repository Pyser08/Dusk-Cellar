const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPlugins, detectHost, MAX_EDITS } = require("../plugins.cjs");

const { sha, tmp, plugin, setup, fakeRisubard } = require("./helpers/fakerisubard.cjs");

const make = async (t, o = {}, fake = {}) => {
  const s = setup(o);
  const risu = await fakeRisubard(s.saveDir, fake);
  t.after(() => risu.close());
  const p = createPlugins({ saveDir: s.saveDir, dataDir: s.dataDir, risuUrl: risu.url, log: () => {} });
  return { ...s, risu, p };
};
const NEW = (name, n = 2) => `//@name ${name}\n//@api 3.0\nconsole.log("${name} ${n}");\n`;

test("호스트 구분: RisuBard 파일이 있으면 risubard, risuai.db면 pocketrisu, 그 외는 risuai", () => {
  assert.equal(detectHost(setup().saveDir), "risubard");
  const pocket = tmp(); fs.writeFileSync(path.join(pocket, "risuai.db"), "");
  assert.equal(detectHost(pocket), "pocketrisu");
  const orig = tmp(); fs.writeFileSync(path.join(orig, "6461746162617365"), "");
  assert.equal(detectHost(orig), "risuai");
  assert.equal(detectHost(path.join(pocket, "없음")), "unknown");
});

test("list: 이름·버전·크기·해시·인자 이름만 주고, 코드와 인자 값(realArg)은 주지 않는다", async (t) => {
  const { p } = await make(t, { plugins: [plugin("dusk_atelier"), plugin("sec", { arguments: { mode: "string" }, realArg: { mode: "VERYSECRET" } })] });
  const r = await p.list();
  assert.equal(r.host, "risubard"); assert.equal(r.location, "settings");
  assert.equal(r.plugins.length, 2);
  const a = r.plugins[0];
  assert.deepEqual({ index: a.index, name: a.name, version: a.version, versionOfPlugin: a.versionOfPlugin, enabled: a.enabled }, { index: 0, name: "dusk_atelier", version: "3.0", versionOfPlugin: "1.0.0", enabled: true });
  assert.equal(a.sha256, sha(plugin("dusk_atelier").script)); assert.equal(a.bytes, Buffer.byteLength(plugin("dusk_atelier").script));
  assert.deepEqual(r.plugins[1].argNames, ["mode"]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("VERYSECRET"), "인자 값이 새면 안 된다");
  assert.ok(!text.includes("console.log"), "코드는 get에서만");
});

test("list: 비밀 이름이 섞여 plugins가 secrets/credentials.json에 있어도 찾는다", async (t) => {
  const { p } = await make(t, { where: "secrets", plugins: [plugin("dusk_atelier", { arguments: { apiKey: "string" }, realArg: { apiKey: "K" } })] });
  const r = await p.list();
  assert.equal(r.location, "secrets"); assert.equal(r.plugins[0].name, "dusk_atelier");
});

test("get: 이름으로 코드를 읽는다. 없으면 404", async (t) => {
  const { p } = await make(t);
  const g = await p.get({ name: "other" });
  assert.equal(g.script, plugin("other").script); assert.equal(g.sha256, sha(plugin("other").script)); assert.equal(g.index, 1);
  await assert.rejects(p.get({ name: "없는플러그인" }), (e) => e.status === 404);
});

test("apply: 고른 플러그인의 script만 바뀌고 나머지(다른 플러그인·다른 설정·형식)는 그대로. 로그인→세션→검토 확인→받아들이기 순서", async (t) => {
  const { p, read, saveDir, dataDir, risu, settingsText, secretsText } = await make(t);
  const before = read("settings/app.json");
  const script = NEW("dusk_atelier");
  const r = await p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script }] });
  assert.equal(r.ok, true); assert.equal(r.needsReload, true); assert.equal(r.adopted, true);
  assert.equal(r.results[0].name, "dusk_atelier"); assert.equal(r.results[0].oldSha, sha(plugin("dusk_atelier").script)); assert.equal(r.results[0].newSha, sha(script));
  const after = read("settings/app.json");
  assert.equal(after.plugins[0].script, script);
  assert.deepEqual({ ...after.plugins[0], script: 0 }, { ...before.plugins[0], script: 0 }, "script 말고는 그대로");
  assert.deepEqual(after.plugins[1], before.plugins[1]); assert.equal(after.theme, "dark"); assert.equal(after.count, 3); assert.equal(after.schemaVersion, 1);
  const text = fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8");
  assert.ok(text.startsWith('{\n  "schemaVersion"') && text.endsWith("}\n"), "들여쓰기·끝 줄바꿈 유지");
  assert.equal(fs.readFileSync(path.join(saveDir, "settings/app.json.sha256"), "utf8"), sha(text) + "\n", "사이드카 체크섬이 새 내용과 맞아야 한다");
  assert.equal(fs.readFileSync(path.join(saveDir, "secrets/credentials.json"), "utf8"), secretsText, "건드리지 않은 파일은 그대로");
  // 고치기 전 파일 스냅샷
  const snaps = fs.readdirSync(path.join(dataDir, "plugin-backups"));
  assert.equal(snaps.length, 1); assert.equal(r.snapshot, snaps[0]);
  assert.equal(fs.readFileSync(path.join(dataDir, "plugin-backups", snaps[0], "settings/app.json"), "utf8"), settingsText);
  // 리스 쪽 호출 순서
  const seq = risu.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(seq, ["POST /api/login", "POST /api/session", "GET /api/external-changes", "GET /api/external-changes", "POST /api/external-changes/resolve", "GET /api/external-changes"]);
  const resolve = risu.calls.find((c) => c.path.endsWith("/resolve"));
  assert.equal(resolve.body.decision, "accept"); assert.match(resolve.headers["x-session-id"], /^cellar-/);
  assert.equal(risu.pending().length, 0, "받아들인 뒤엔 검토 대기가 없다");
});

test("apply: 여러 플러그인을 한 번에 고친다(파일은 한 번만 쓴다)", async (t) => {
  const { p, read } = await make(t);
  const r = await p.apply({ edits: [
    { name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier", 5) },
    { name: "other", expectSha: sha(plugin("other").script), script: NEW("other", 7) },
  ] });
  assert.equal(r.results.length, 2);
  const a = read("settings/app.json");
  assert.ok(a.plugins[0].script.includes("dusk_atelier 5") && a.plugins[1].script.includes("other 7"));
});

test("apply: plugins가 secrets/credentials.json에 있으면 그 파일을 고친다", async (t) => {
  const { p, read } = await make(t, { where: "secrets", plugins: [plugin("dusk_atelier", { arguments: { apiKey: "string" }, realArg: { apiKey: "K" } })] });
  const r = await p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier", 9) }] });
  assert.equal(r.ok, true);
  const c = read("secrets/credentials.json");
  assert.ok(c.plugins[0].script.includes("dusk_atelier 9")); assert.equal(c.plugins[0].realArg.apiKey, "K"); assert.equal(c.openaiKey, "sk-xxx");
});

test("apply: 현재 코드의 해시가 다르면(그새 바뀜) 409 — 파일은 그대로, 리스를 부르지도 않는다", async (t) => {
  const { p, saveDir, settingsText, risu } = await make(t);
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha("다른 코드"), script: NEW("dusk_atelier") }] }), (e) => e.status === 409 && e.extra?.conflict === true && e.extra.currentSha === sha(plugin("dusk_atelier").script));
  assert.equal(fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8"), settingsText);
  assert.equal(risu.calls.length, 0);
});

test("apply: 없는 플러그인 404, 머리말 //@name이 바뀌면 400, 빈 코드·잘못된 입력 400 — 모두 파일 그대로", async (t) => {
  const { p, saveDir, settingsText } = await make(t);
  const ok = sha(plugin("dusk_atelier").script);
  await assert.rejects(p.apply({ edits: [{ name: "없음", expectSha: ok, script: "x" }] }), (e) => e.status === 404);
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: ok, script: NEW("다른이름") }] }), (e) => e.status === 400 && /name/.test(e.message));
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: ok, script: "" }] }), (e) => e.status === 400);
  await assert.rejects(p.apply({ edits: [] }), (e) => e.status === 400);
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: "zz", script: NEW("dusk_atelier") }] }), (e) => e.status === 400);
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: ok, script: NEW("dusk_atelier") }, { name: "dusk_atelier", expectSha: ok, script: NEW("dusk_atelier", 3) }] }), (e) => e.status === 400, "같은 플러그인을 두 번 고칠 수 없다");
  await assert.rejects(p.apply({ edits: Array.from({ length: MAX_EDITS + 1 }, () => ({ name: "dusk_atelier", expectSha: ok, script: "x" })) }), (e) => e.status === 400);
  assert.equal(fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8"), settingsText);
});

test("apply: 같은 이름이 둘이면 index로 고른다(없으면 400)", async (t) => {
  const { p, read } = await make(t, { plugins: [plugin("dup"), plugin("dup", { script: "//@name dup\nB\n" })] });
  await assert.rejects(p.apply({ edits: [{ name: "dup", expectSha: sha(plugin("dup").script), script: NEW("dup") }] }), (e) => e.status === 400);
  const r = await p.apply({ edits: [{ name: "dup", index: 1, expectSha: sha("//@name dup\nB\n"), script: NEW("dup", 4) }] });
  assert.equal(r.ok, true);
  assert.ok(read("settings/app.json").plugins[1].script.includes("dup 4")); assert.equal(read("settings/app.json").plugins[0].script, plugin("dup").script);
});

test("apply: 리스 암호 파일이 없거나 로그인에 실패하면 파일을 쓰기 전에 멈춘다(424)", async (t) => {
  const a = await make(t);
  fs.rmSync(path.join(a.saveDir, "__password"));
  await assert.rejects(a.p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier") }] }), (e) => e.status === 424);
  assert.equal(fs.readFileSync(path.join(a.saveDir, "settings/app.json"), "utf8"), a.settingsText);
  const b = await make(t, {}, { failLogin: true });
  await assert.rejects(b.p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier") }] }), (e) => e.status === 424);
  assert.equal(fs.readFileSync(path.join(b.saveDir, "settings/app.json"), "utf8"), b.settingsText);
  assert.equal(fs.existsSync(path.join(b.dataDir, "plugin-backups")), false, "멈췄으면 스냅샷도 안 만든다");
});

test("apply: 리스에 이미 검토 대기 중인 외부 변경이 있으면 건드리지 않고 409", async (t) => {
  const { p, saveDir, risu, read } = await make(t);
  risu.editExternally("secrets/credentials.json", JSON.stringify({ schemaVersion: 1, openaiKey: "바뀜" }) + "\n");
  const before = fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8");
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier") }] }), (e) => e.status === 409 && e.extra?.pending === true);
  assert.equal(fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8"), before);
  assert.equal(read("secrets/credentials.json").openaiKey, "바뀜", "사용자의 다른 외부 수정은 그대로 둔다");
  assert.ok(!risu.calls.some((c) => c.path.endsWith("/resolve")), "남의 변경을 대신 받아들이면 안 된다");
});

test("apply: 쓴 뒤 우리 파일 말고 다른 변경이 섞여 있으면 받아들이지 않고 안내(파일은 쓴 채로, 리스 화면에서 검토)", async (t) => {
  const { p, risu, dataDir } = await make(t, {}, { extraPending: ["chars/other.json"] });
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier") }] }), (e) => e.status === 409 && e.extra?.written === true && e.extra?.snapshot && e.extra?.others?.includes("chars/other.json"));
  assert.ok(!risu.calls.some((c) => c.path.endsWith("/resolve")), "남의 변경을 대신 받아들이면 안 된다");
  assert.equal(fs.readdirSync(path.join(dataDir, "plugin-backups")).length, 1);
});

test("apply: 받아들이기가 실패하면(세션 밀림 423) 쓴 파일은 그대로 두고 리스 화면에서 받아들이라고 알린다. 스냅샷은 남는다", async (t) => {
  const { p, saveDir, dataDir, settingsText } = await make(t, {}, { staleResolve: true });
  await assert.rejects(p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier") }] }), (e) => e.status === 502 && e.extra?.written === true && Boolean(e.extra?.snapshot));
  assert.ok(JSON.parse(fs.readFileSync(path.join(saveDir, "settings/app.json"), "utf8")).plugins[0].script.includes("dusk_atelier 2"));
  const snaps = fs.readdirSync(path.join(dataDir, "plugin-backups"));
  assert.equal(fs.readFileSync(path.join(dataDir, "plugin-backups", snaps[0], "settings/app.json"), "utf8"), settingsText);
});

test("apply: 동시에 두 번 불러도 차례로 처리된다(둘째는 이미 바뀐 해시라 409)", async (t) => {
  const { p } = await make(t);
  const edit = { name: "dusk_atelier", expectSha: sha(plugin("dusk_atelier").script), script: NEW("dusk_atelier", 2) };
  const [a, b] = await Promise.allSettled([p.apply({ edits: [edit] }), p.apply({ edits: [{ ...edit, script: NEW("dusk_atelier", 3) }] })]);
  assert.equal(a.status, "fulfilled"); assert.equal(b.status, "rejected"); assert.equal(b.reason.status, 409);
});

test("스냅샷은 20개까지만 남긴다", async (t) => {
  const { p, dataDir } = await make(t);
  let cur = plugin("dusk_atelier").script;
  for (let i = 0; i < 23; i++) { const next = NEW("dusk_atelier", 100 + i); await p.apply({ edits: [{ name: "dusk_atelier", expectSha: sha(cur), script: next }] }); cur = next; }
  assert.equal(fs.readdirSync(path.join(dataDir, "plugin-backups")).length, 20);
});

test("RisuBard가 아닌 호스트는 아직 지원하지 않는다(501)", async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, "risuai.db"), "");
  const p = createPlugins({ saveDir: dir, dataDir: tmp(), risuUrl: "http://127.0.0.1:1", log: () => {} });
  await assert.rejects(p.list(), (e) => e.status === 501 && e.extra?.host === "pocketrisu");
  await assert.rejects(p.apply({ edits: [{ name: "a", expectSha: sha("x"), script: "x" }] }), (e) => e.status === 501);
});

test("gzip: get은 scriptZ로 주고, apply는 scriptZ로 받은 코드를 풀어서 고친다", async () => {
  const zlib = require("node:zlib");
  const { setup, fakeRisubard, plugin } = require("./helpers/fakerisubard.cjs");
  const s = setup({ plugins: [plugin("a")] });
  const fr = await fakeRisubard(s.saveDir);
  try {
    const p = createPlugins({ saveDir: s.saveDir, dataDir: s.dataDir, risuUrl: fr.url, log() {} });
    const g = await p.get({ name: "a", gzip: true });
    assert.equal(g.script, undefined);
    const text = zlib.gunzipSync(Buffer.from(g.scriptZ, "base64")).toString("utf8");
    assert.match(text, /^\/\/@name a/);
    const next = text.replace("a 1", "a 2");
    await p.apply({ edits: [{ name: "a", expectSha: g.sha256, scriptZ: zlib.gzipSync(Buffer.from(next)).toString("base64") }] });
    assert.equal(s.read("settings/app.json").plugins[0].script, next);
    await assert.rejects(p.apply({ edits: [{ name: "a", expectSha: "0".repeat(64), scriptZ: "not-gzip" }] }), (e) => e.status === 400);
  } finally { await fr.close(); }
});
