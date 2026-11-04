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
  const j = await waitDone(a);   // 아무도 가져가지 않아 timeout → 실패로 센다
  assert.equal(j.state, "done"); assert.equal(j.failed, 1); assert.match(j.reasons[0], /timeout/);
  const b = mk().a;
  b.start({ chaId: "c1", chatId: "t1", charName: "봇", messages: msgs(), settings: { staged: false }, model: { kind: "relay" } });
  await new Promise((r) => setTimeout(r, 30)); b.cancel();
  const k = await waitDone(b); assert.ok(["cancelled", "done"].includes(k.state));
  assert.equal(a.relayResult({}).accepted, false, "끝난 작업에 늦게 온 결과는 무시");
  const c = mk().a; assert.throws(() => c.relayResult({}), (e) => e.status === 409);
});
