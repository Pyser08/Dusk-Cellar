"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createStore } = require("../store.cjs");
const { createAnalysis, slimMessage, createModelCall } = require("../analysis.cjs");

const LONG = "비가 내리는 옥상에서 미나가 하루의 손을 잡고 오래 숨겨 둔 비밀을 처음으로 털어놓았다. 하루는 아무 대답도 하지 못했다. ".repeat(2);
const GOOD = JSON.stringify({ people: [{ name: "미나", act: "하루에게 비밀을 털어놓음", p: 2, s: 2, r: 2 }], scene: { sum: "비 오는 옥상", facts: ["비밀 공개"], place: "옥상", who: ["미나", "하루"], changed: true } });
const msgs = () => [{ role: "user", data: "안녕", secret: "x" }, { role: "char", data: LONG, chatId: "m1" }, { role: "user", data: "그래서?" }, { role: "char", data: LONG + "!", chatId: "m2" }];

function fakeModel(reply = GOOD, { status = 200 } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => b += c); req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization, key: req.headers["x-api-key"], body: JSON.parse(b) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/messages" ? { content: [{ type: "text", text: reply }] } : { choices: [{ message: { content: reply } }] }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const waitDone = async (a) => { for (let i = 0; i < 200; i++) { const j = a.status().job; if (j && j.state !== "running") return j; await new Promise((r) => setTimeout(r, 25)); } throw new Error("시간 초과"); };
const mk = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cellar-an-")); const mem = createStore({ dir }); return { dir, mem, a: createAnalysis({ mem }) }; };

test("slimMessage는 분석에 필요한 필드만 남긴다", () => {
  assert.deepEqual(slimMessage({ role: "user", data: "a", secret: "x", chatId: "c" }), { role: "user", data: "a", chatId: "c" });
});

test("서버에서 지난 대화 분석: 모델 호출 → 기억 폴더가 저장소에 쓰이고 진행이 보인다", async () => {
  const { srv, hits, base } = await fakeModel();
  const { mem, a } = mk();
  try {
    assert.equal(a.available(), true);
    a.start({ chaId: "c1", chatId: "t1", charName: "봇", chatName: "채팅1", messages: msgs(), settings: { staged: false }, userNames: ["하윤"], model: { kind: "openai", url: base + "/v1/chat/completions", key: "sk-test", model: "m" } });
    const j = await waitDone(a);
    assert.equal(j.state, "done", j.error);
    assert.equal(j.total, 1); assert.equal(j.failed, 0);
    assert.ok(hits.length >= 1); assert.equal(hits[0].auth, "Bearer sk-test");
    const keys = mem.list("dusk.mem.v3.f.");
    assert.equal(keys.length, 1, "기억 폴더 하나만 저장소에 써요(인덱스는 저장 안 함)");
    const folder = JSON.parse(mem.get(keys[0].key).value);
    assert.ok(folder.people["미나"]);
    assert.equal(mem.list("dusk.mem.v3.index").length, 0);
    assert.equal(JSON.stringify(a.status()).includes("sk-test"), false, "상태에 키가 새지 않아요");
  } finally { srv.close(); }
});

test("이미 분석한 응답은 건너뛰고(redo면 다시), 두 번째 작업이 가능하다", async () => {
  const { srv, hits, base } = await fakeModel();
  const { a } = mk();
  const req = { chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "openai", url: base + "/x", model: "m" } };
  try {
    a.start(req); await waitDone(a);
    const n1 = hits.length;
    a.start(req); const j2 = await waitDone(a);
    assert.equal(j2.total, 0); assert.equal(hits.length, n1);
    a.start({ ...req, redo: true, range: { all: true } }); const j3 = await waitDone(a);
    assert.equal(j3.total, 1); assert.ok(hits.length > n1);
  } finally { srv.close(); }
});

test("Anthropic 형식도 보낸다", async () => {
  const { srv, hits, base } = await fakeModel();
  const { a } = mk();
  try {
    a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "anthropic", url: base + "/v1/messages", key: "ak", model: "claude" } });
    const j = await waitDone(a); assert.equal(j.state, "done", j.error);
    assert.equal(hits[0].key, "ak"); assert.ok(hits[0].body.system !== undefined || hits[0].body.messages.length);
  } finally { srv.close(); }
});

test("모델 오류는 실패로 세고 작업은 끝난다(기억은 쓰지 않음)", async () => {
  const { srv, base } = await fakeModel("nope", { status: 400 });
  const { mem, a } = mk();
  try {
    a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, retryMs: 1, model: { kind: "openai", url: base + "/x", model: "m" } });
    const j = await waitDone(a);
    assert.equal(j.state, "done"); assert.equal(j.failed, 1); assert.ok(j.reasons[0].includes("400"));
    const ks = mem.list("dusk.mem.v3.f.");
    assert.equal(ks.length, 1, "실패한 응답은 폴더에 실패로만 남아요");
    const f = JSON.parse(mem.get(ks[0].key).value);
    assert.deepEqual(Object.keys(f.people), []); assert.equal(f.failedBackfill.length, 2);
  } finally { srv.close(); }
});

test("취소하면 멈춘다 · 분석 중에 또 시작하면 409 · 잘못된 입력은 400", async () => {
  const srv = http.createServer(() => { /* 응답 없음 */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { a } = mk();
  try {
    const req = { chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "openai", url: `http://127.0.0.1:${srv.address().port}/x`, model: "m" } };
    a.start(req);
    await assert.rejects(async () => a.start(req), (e) => e.status === 409);
    a.cancel();
    const j = await waitDone(a);
    assert.ok(["cancelled", "done"].includes(j.state));
    await assert.rejects(async () => a.start({ ...req, messages: [] }), (e) => e.status === 400);
    await assert.rejects(async () => a.start({ ...req, chaId: "" }), (e) => e.status === 400);
    assert.throws(() => createModelCall({ url: "ftp://x", model: "m" }, fetch), (e) => e.status === 400);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test("엔진 파일이 없으면 available=false, start는 501", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cellar-an-"));
  const a = createAnalysis({ mem: createStore({ dir }), engineFile: path.join(dir, "none.mjs") });
  assert.equal(a.available(), false);
  await assert.rejects(async () => a.start({}), (e) => e.status === 501);
});

test("요청 본문: 추가 JSON·추론 설정·OpenRouter·OpenAI 추론 모델 규칙", async () => {
  const bodies = [];
  const fake = async (url, init) => { bodies.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "x" } }], content: [{ text: "x" }] }) }; };
  const msgs = [{ role: "system", content: "S" }, { role: "user", content: "U" }];
  const call = (m) => createModelCall({ url: "https://h.example/v1/chat/completions", model: "m", ...m }, fake)(msgs, {});
  await call({ kind: "openai", temperature: 0.5, maxTokens: 100, extraBody: { top_p: 0.9, foo: 1 }, extraHeaders: { "x-a": "b" }, key: "k" });
  assert.deepEqual([bodies[0].body.top_p, bodies[0].body.foo, bodies[0].body.max_tokens, bodies[0].body.temperature], [0.9, 1, 100, 0.5]);
  assert.equal(bodies[0].headers["x-a"], "b"); assert.equal(bodies[0].headers.authorization, "Bearer k");
  await call({ kind: "openai", openrouter: true, reasoningEffort: "high", extraBody: { reasoning: { max_tokens: 5 } } });
  assert.deepEqual(bodies[1].body.reasoning, { max_tokens: 5, effort: "high" }); assert.equal(bodies[1].body.reasoning_effort, undefined);
  await call({ kind: "openai", openaiReasoning: true, temperature: 0.7, maxTokens: 50, reasoningEffort: "low", extraBody: { top_p: 1 } });
  assert.equal(bodies[2].body.max_tokens, undefined); assert.equal(bodies[2].body.max_completion_tokens, 50); assert.equal(bodies[2].body.temperature, undefined); assert.equal(bodies[2].body.top_p, undefined);
  await call({ kind: "openai", openaiReasoning: true, temperature: 0.7, reasoningEffort: "none" });
  assert.equal(bodies[3].body.temperature, 0.7, "reasoning_effort none이면 샘플링을 지우지 않는다");
  await call({ kind: "anthropic", url: "https://a.example/v1/messages", key: "ak", extraBody: { thinking: { type: "disabled" } } });
  assert.equal(bodies[4].body.max_tokens, 4096); assert.equal(bodies[4].body.system, "S"); assert.deepEqual(bodies[4].body.thinking, { type: "disabled" }); assert.equal(bodies[4].headers["x-api-key"], "ak");
});

test("중계 모드: 서버가 모델을 부르지 않고 플러그인이 호출을 가져가 결과를 돌려준다", async () => {
  const { mem, a } = mk();
  a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "relay" } });
  let handled = 0;
  for (let i = 0; i < 200 && a.status().job.state === "running"; i++) {
    const { calls = [] } = a.status({ claim: true });
    for (const c of calls) { assert.ok(Array.isArray(c.messages) && c.messages.length); assert.equal(a.relayResult({ callId: c.id, text: GOOD }).accepted, true); handled++; }
    assert.deepEqual(a.status({ claim: true }).calls, [], "이미 가져간 요청은 다시 주지 않아요");
    await new Promise((r) => setTimeout(r, 20));
  }
  const j = a.status().job;
  assert.equal(j.state, "done", j.error); assert.ok(handled >= 1);
  const ks = mem.list("dusk.mem.v3.f."); assert.ok(JSON.parse(mem.get(ks[0].key).value).people["미나"]);
  assert.equal(a.relayResult({ callId: "k999", text: "x" }).accepted, false);
});

test("중계 모드: 플러그인이 오류를 돌려주면 실패로 세고, 답이 없으면 시간 초과, 취소하면 멈춘다", async () => {
  const { a } = mk();
  a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, retryMs: 1, model: { kind: "relay", relayWaitSec: 0.05 } });
  const j = await waitDone(a);   // maxWaitSec을 준 경우에만: 아무도 가져가지 않아 timeout → 실패로 센다
  assert.equal(j.state, "done"); assert.equal(j.failed, 1); assert.match(j.reasons[0], /timeout/);
  const b = mk().a;
  b.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "relay" } });
  await new Promise((r) => setTimeout(r, 30)); b.cancel();
  const k = await waitDone(b); assert.ok(["cancelled", "done"].includes(k.state));
  assert.equal(a.relayResult({}).accepted, false, "끝난 작업에 늦게 온 결과는 무시");
  const c = mk().a; assert.throws(() => c.relayResult({}), (e) => e.status === 409);
});

test("중계 모드: 플러그인이 없어도 작업은 실패하지 않고 기다리다, 다시 와서 가져가면 이어서 끝난다", async () => {
  const { a } = mk();
  a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "relay" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(a.status().job.state, "running", "기다리는 중에도 실패하지 않아요");
  assert.equal(a.status().job.relay, true);
  const calls = a.status({ claim: true }).calls; assert.equal(calls.length, 1);
  assert.equal(a.relayResult({ callId: calls[0].id, text: GOOD }).accepted, true);
  const j = await waitDone(a); assert.equal(j.state, "done", j.error);
});

test("createRelay: 가져간 뒤 오래 답이 없으면 다시 내주고, 대기 표시가 켜진다", () => {
  let t = 1000; const { createRelay } = require("../analysis.cjs");
  const r = createRelay({ now: () => t });
  r.call([{ role: "user", content: "a" }], { timeoutSec: 10 }).catch(() => {});
  assert.equal(r.claim().length, 1); assert.equal(r.claim().length, 0);
  t += 60e3; assert.equal(r.claim().length, 0, "아직 제한시간+60초 전이에요");
  t += 20e3; assert.equal(r.waiting(), true); assert.equal(r.claim().length, 1, "오래 지나면 다시 내줘요");
});

// ── 프리셋 호출(플러그인과 같은 모델 호출 코드) ──
const crypto = require("node:crypto");
const PRESET = { provider: "custom", baseUrl: "https://fake.test/v1", model: "m", temperature: 0.5, maxTokens: 512, timeoutSeconds: 30, contextWindow: 10, reasoningQuickSetting: "default", extraBodyJson: "", receiveContextAsPdf: false, vertexPaygoTier: "default" };
const resp = (json, status = 200) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
const mkWith = (fetchImpl, extra = {}) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cellar-an-")); const mem = createStore({ dir }); return { dir, mem, a: createAnalysis({ mem, fetchImpl, ...extra }) }; };

test("프리셋 호출: custom 모델을 플러그인과 같은 코드로 부르고 키·추가 JSON이 반영된다", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return resp({ choices: [{ message: { content: GOOD } }] }); };
  const { mem, a } = mkWith(fetchImpl);
  await a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "preset", preset: { ...PRESET, extraBodyJson: '{"top_p":0.3}' }, key: "sk-live" } });
  const j = await waitDone(a); assert.equal(j.state, "done", j.error); assert.equal(j.failed, 0);
  assert.equal(seen[0].url, "https://fake.test/v1/chat/completions");
  assert.equal(seen[0].init.headers.authorization, "Bearer sk-live"); assert.equal(seen[0].body.top_p, 0.3); assert.equal(seen[0].body.model, "m");
  assert.ok(JSON.parse(mem.get(mem.list("dusk.mem.v3.f.")[0].key).value).people["미나"]);
  assert.equal(JSON.stringify(a.status()).includes("sk-live"), false);
});

test("프리셋 호출: Vertex 서비스 계정 서명(JWT)·토큰 교환·Bearer 호출이 서버에서도 된다", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = { type: "service_account", project_id: "my-proj", client_email: "sa@my-proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const assertion = new URLSearchParams(init.body).get("assertion"), [h, c, sig] = assertion.split(".");
      assert.ok(crypto.verify("RSA-SHA256", Buffer.from(h + "." + c), publicKey, Buffer.from(sig, "base64url")), "JWT 서명이 맞아야 해요");
      assert.equal(JSON.parse(Buffer.from(c, "base64url")).iss, account.client_email);
      return resp({ access_token: "ya29.tok", token_type: "Bearer", expires_in: 3600 });
    }
    assert.match(url, /^https:\/\/[a-z-]*aiplatform\.googleapis\.com\//); assert.equal(init.headers.authorization, "Bearer ya29.tok");
    return resp({ candidates: [{ content: { parts: [{ text: GOOD }] }, finishReason: "STOP" }] });
  };
  const { mem, a } = mkWith(fetchImpl);
  await a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "preset", key: JSON.stringify(account), preset: { ...PRESET, provider: "vertex-ai", baseUrl: "https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi", model: "gemini-2.5-flash" } } });
  const j = await waitDone(a); assert.equal(j.state, "done", j.error); assert.equal(j.failed, 0, j.reasons.join("|"));
  assert.equal(calls.filter((u) => u.startsWith("https://oauth2")).length, 1, "토큰은 한 번만 받아 재사용");
  assert.ok(JSON.parse(mem.get(mem.list("dusk.mem.v3.f.")[0].key).value).people["미나"]);
});

test("프리셋 호출: 리스 보조 모델 프리셋·주소 없는 프리셋은 400", async () => {
  const { a } = mkWith(async () => resp({}));
  await assert.rejects(async () => a.start({ chaId: "c", chatId: "t", messages: msgs(), model: { kind: "preset", preset: { ...PRESET, provider: "risuai" }, key: "" } }), (e) => e.status === 400);
  await assert.rejects(async () => a.start({ chaId: "c", chatId: "t", messages: msgs(), model: { kind: "preset", preset: { ...PRESET, baseUrl: "" }, key: "" } }), (e) => e.status === 400);
});

// ── 기억 손실 방지 ──
const manyMsgs = (n) => { const o = []; for (let i = 0; i < n; i++) { o.push({ role: "user", data: `입력 ${i}` }); o.push({ role: "char", data: `${LONG} 응답 번호 ${i}`, chatId: `m${i}` }); } return o; };
const personFor = (k) => JSON.stringify({ people: [{ name: `인물${k}`, act: `행동 ${k}`, p: 2, s: 2, r: 2 }], scene: { sum: `장면 ${k}`, facts: [`사실 ${k}`], place: "곳", who: [`인물${k}`], changed: true } });

test("동시 쓰기: 서버 분석 중 플러그인이 같은 폴더를 계속 바꿔도 양쪽 기록이 모두 남는다(중복 없음)", async () => {
  let n = 0;
  const fetchImpl = async () => { await new Promise((r) => setTimeout(r, 12)); return resp({ choices: [{ message: { content: personFor(++n) } }] }); };
  const { mem, a } = mkWith(fetchImpl);
  const put0 = mem.put; let conflicts = 0;   // 서버 쪽 쓰기가 실제로 충돌했는지 센다
  mem.put = (...x) => { try { return put0(...x); } catch (e) { if (e.conflict) conflicts++; throw e; } };
  await a.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: manyMsgs(14), settings: { staged: false }, retryMs: 1, model: { kind: "preset", preset: PRESET, key: "k" } });
  // 플러그인 흉내: baseRev로 읽고-고치고-쓰기, 충돌이면 다시 읽어 합쳐서 쓰기(실제 플러그인의 pushKey와 같은 순서)
  let ext = 0, stop = false;
  const writer = (async () => {
    while (!stop) {
      const ks = mem.list("dusk.mem.v3.f.");
      if (ks.length) {
        for (let tries = 0; tries < 20; tries++) {
          const g = mem.get(ks[0].key), f = JSON.parse(g.value);
          f.people[`외부${ext}`] = { name: `외부${ext}`, aliases: [], pinned: false, records: [{ id: `x${ext}`, act: "외부 기록", at: 0, g: "B" }] };
          try { mem.put(ks[0].key, JSON.stringify(f), { baseRev: g.rev }); ext++; break; } catch (e) { if (!e.conflict) throw e; }
        }
      }
      await new Promise((r) => setTimeout(r, 3));
    }
  })();
  const j = await waitDone(a); stop = true; await writer;
  assert.equal(j.state, "done", j.error); assert.equal(j.failed, 0, j.reasons.join("|"));
  const f = JSON.parse(mem.get(mem.list("dusk.mem.v3.f.")[0].key).value);
  const server = Object.keys(f.people).filter((k) => /^인물\d+$/.test(k)), external = Object.keys(f.people).filter((k) => /^외부\d+$/.test(k));
  assert.equal(server.length, n, `서버가 만든 기록이 모두 남아야 해요(모델 호출 ${n}번, 남은 ${server.length})`);
  assert.equal(external.length, ext, "플러그인이 쓴 기록도 하나도 안 사라져야 해요");
  assert.ok(ext >= 3 && conflicts >= 1, "시험이 실제로 겹쳤어요(외부 쓰기 " + ext + "번, 충돌 " + conflicts + "번)");
  for (const k of server) assert.equal(f.people[k].records.length, 1, `${k} 기록이 중복되면 안 돼요`);
});

test("취소 후 다시 시작하면 남은 것만 분석하고 기존 기록은 그대로다(중복·손실 없음)", async () => {
  let n = 0, gate = null;
  const fetchImpl = async () => { if (gate) await gate; return resp({ choices: [{ message: { content: personFor(++n) } }] }); };
  const { mem, a } = mkWith(fetchImpl);
  const req = { chaId: "c1", chatId: "t1", charName: "봇", messages: manyMsgs(10), settings: { staged: false }, retryMs: 1, model: { kind: "preset", preset: PRESET, key: "k" } };
  await a.start(req);
  for (let i = 0; i < 400 && n < 2; i++) await new Promise((r) => setTimeout(r, 5));
  a.cancel(); const j1 = await waitDone(a); assert.ok(["cancelled", "done"].includes(j1.state));
  const keyOf = () => mem.list("dusk.mem.v3.f.")[0].key, before = JSON.parse(mem.get(keyOf()).value), had = Object.keys(before.people).filter((k) => /^인물\d+$/.test(k)).length;
  assert.ok(had >= 1);
  await a.start(req); const j2 = await waitDone(a); assert.equal(j2.state, "done", j2.error); assert.equal(j2.failed, 0);
  const after = JSON.parse(mem.get(keyOf()).value), names = Object.keys(after.people).filter((k) => /^인물\d+$/.test(k));
  for (const k of Object.keys(before.people)) assert.ok(after.people[k], `${k}가 사라졌어요`);
  assert.equal(names.length, n, "모델이 만든 기록이 하나도 안 사라지고 중복도 없어요");
  for (const k of names) assert.equal(after.people[k].records.length, 1);
  const total = after.done?.length ?? 0; assert.ok(total >= 10, "모든 응답이 분석 완료로 표시돼요");
});

test("분석 전 폴더 백업이 남고(최근 5개) 쓸 수 있다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cellar-bk-"));
  let n = 0;
  const { mem, a } = mkWith(async () => resp({ choices: [{ message: { content: personFor(++n) } }] }), { backupDir: dir });
  const req = { chaId: "c1", chatId: "t1", charName: "봇", messages: manyMsgs(2), settings: { staged: false }, retryMs: 1, model: { kind: "preset", preset: PRESET, key: "k" } };
  await a.start(req); await waitDone(a);
  assert.equal(fs.readdirSync(dir).length, 0, "처음에는 백업할 폴더가 없어요");
  for (let i = 0; i < 7; i++) { await a.start({ ...req, redo: true, range: { all: true } }); await waitDone(a); }
  const files = fs.readdirSync(dir).sort(); assert.equal(files.length, 5);
  const b = JSON.parse(fs.readFileSync(path.join(dir, files.at(-1)), "utf8"));
  assert.ok(b.key.startsWith("dusk.mem.v3.f.") && typeof b.value === "string" && JSON.parse(b.value).people);
});
