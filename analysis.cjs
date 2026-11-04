"use strict";
// 서버 분석 (0.1.1): 장기 기억 분석(지난 대화 분석)을 서버에서 돌려, 기기(아이폰 등)의 메모리·배터리를 아낀다.
//   · 분석 엔진은 Atelier 소스를 한 파일로 묶은 engine/atelier-engine.mjs(Atelier `node tools/build-cellar-engine.mjs`로 만든다)를 그대로 쓴다.
//   · 플러그인이 채팅(메시지)·설정·모델 정보를 보내면 서버가 모델을 부르고 결과를 Cellar 기억 저장소(dusk.mem.v3.f.*)에 쓴다. 플러그인은 진행만 본다.
//   · 모델 키는 작업이 도는 동안 메모리에만 두고 저장·기록하지 않는다. 한 번에 작업 하나.
//   · 서버가 없거나 이 기능이 꺼져 있으면(health features에 analysis 없음) 플러그인은 지금 방식 그대로 기기에서 분석한다.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_MESSAGES = 50000;
const KEEP_FIELDS = ["role", "data", "content", "text", "mes", "message", "chatId", "isUser", "is_user", "type", "isStreaming", "streaming", "time"];

// 메시지에서 분석에 필요한 필드만 남긴다(보내는 양·서버 메모리 절약, 키 등 엉뚱한 값 차단)
const slimMessage = (m) => { const o = {}; for (const k of KEEP_FIELDS) if (m && m[k] !== undefined) o[k] = m[k]; return o; };

// 모델 호출(OpenAI 호환 · Anthropic 형식). messages: [{role, content}] → 문자열
function createModelCall(model, fetchImpl) {
  const kind = model?.kind === "anthropic" ? "anthropic" : "openai";
  let url; try { url = new URL(String(model?.url ?? "")); } catch { throw fail(400, "모델 주소(url)가 올바르지 않아요"); }
  if (!/^https?:$/.test(url.protocol)) throw fail(400, "모델 주소는 http(s)만 쓸 수 있어요");
  if (!model.model || typeof model.model !== "string") throw fail(400, "모델 이름(model)이 필요해요");
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n") : String(c ?? ""));
  return async (messages, pick = {}, signal) => {
    const ctrl = new AbortController(), sec = Number(pick?.timeoutSec) > 0 ? Number(pick.timeoutSec) : 600;
    const t = setTimeout(() => ctrl.abort(), sec * 1000);
    const onAbort = () => ctrl.abort(); signal?.addEventListener?.("abort", onAbort);
    try {
      // 요청 본문: Atelier llm-client.js와 같은 규칙(추가 JSON·추론 설정·OpenRouter reasoning·OpenAI 추론 모델)
      const extra = model.extraBody && typeof model.extraBody === "object" && !Array.isArray(model.extraBody) ? model.extraBody : {};
      const extraHeaders = model.extraHeaders && typeof model.extraHeaders === "object" ? model.extraHeaders : {};
      let body, headers = { "content-type": "application/json", ...extraHeaders, ...(model.headers && typeof model.headers === "object" ? model.headers : {}) };
      if (kind === "anthropic") {
        const sys = messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");
        const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: text(m.content) }));
        body = { model: model.model, max_tokens: model.maxTokens || 4096, ...(model.temperature != null ? { temperature: model.temperature } : {}), ...(sys ? { system: sys } : {}), messages: rest, ...extra };
        headers = { ...headers, "x-api-key": model.key ?? "", "anthropic-version": "2023-06-01" };
      } else {
        body = { model: model.model, messages: messages.map((m) => ({ role: m.role, content: text(m.content) })), ...(model.temperature != null ? { temperature: model.temperature } : {}), ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}), ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}), ...extra };
        if (model.openrouter && model.reasoningEffort) { delete body.reasoning_effort; body.reasoning = { ...(extra.reasoning || {}), effort: model.reasoningEffort }; }
        if (model.openaiReasoning) {
          if (Object.hasOwn(body, "max_tokens")) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
          if ((body.reasoning_effort || "default") !== "none") { delete body.temperature; delete body.top_p; }
        }
        if (model.key) headers.authorization = `Bearer ${model.key}`;
      }
      const res = await fetchImpl(url.href, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      const raw = await res.text();
      let j = null; try { j = JSON.parse(raw); } catch { /* 아래에서 오류 처리 */ }
      if (!res.ok) throw new Error(`모델 응답 오류 ${res.status}: ${String(j?.error?.message ?? j?.error ?? raw).slice(0, 200)}`);
      const out = kind === "anthropic" ? (j?.content ?? []).map((p) => p?.text ?? "").join("") : j?.choices?.[0]?.message?.content;
      if (typeof out !== "string" || !out.trim()) throw new Error("모델이 빈 응답을 보냈어요");
      return out;
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error(signal?.aborted ? "AI 작업을 취소했어요." : `보조 모델 응답이 ${sec}초 제한시간을 넘었어요.`);
      throw e;
    } finally { clearTimeout(t); signal?.removeEventListener?.("abort", onAbort); }
  };
}

// 중계 호출: 모델 호출을 서버가 직접 하지 않고 플러그인에게 맡긴다(플러그인이 리스 보조 모델·Vertex·Copilot 등 기존 인증 방식 그대로 호출).
// 서버는 요청을 큐에 쌓고, 플러그인이 status로 가져가(claim) 결과를 result로 돌려줄 때까지 기다린다.
// 플러그인(리스 화면)이 꺼져 있어도 작업은 실패하지 않고 기다린다 — 리스 화면이 다시 열려 status를 부르면 이어서 한다(Cellar가 재시작되지 않는 한).
// 가져간 뒤 오래(모델 제한시간+60초) 결과가 없으면 다른 요청처럼 다시 내준다(가져간 쪽이 꺼진 경우). maxWaitSec(선택)을 주면 그 시간 뒤 실패로 본다.
function createRelay({ maxWaitSec = 0, now = () => Date.now() } = {}) {
  const pending = new Map(); let seq = 0;
  const call = (messages, pick, signal) => new Promise((resolve, reject) => {
    const id = `k${++seq}`, ent = { id, messages, pick: { timeoutSec: pick?.timeoutSec }, claimedAt: 0, at: now() };
    const t = maxWaitSec > 0 ? setTimeout(() => done(reject, new Error(`플러그인 응답 timeout (${maxWaitSec}초). 리스 화면이 꺼졌거나 절전 중일 수 있어요`)), maxWaitSec * 1000) : null;
    const done = (fn, v) => { if (t) clearTimeout(t); pending.delete(id); signal?.removeEventListener?.("abort", onAbort); fn(v); };
    const onAbort = () => done(reject, new Error("AI 작업을 취소했어요."));
    signal?.addEventListener?.("abort", onAbort);
    ent.resolve = (text) => done(resolve, text); ent.reject = (e) => done(reject, e);
    pending.set(id, ent);
  });
  const reclaimMs = (e) => ((Number(e.pick.timeoutSec) > 0 ? Number(e.pick.timeoutSec) : 600) + 60) * 1000;
  const claim = () => { const out = []; for (const e of pending.values()) if (!e.claimedAt || now() - e.claimedAt > reclaimMs(e)) { e.claimedAt = now(); out.push({ id: e.id, messages: e.messages, pick: e.pick }); } return out; };
  const result = (id, { text, error }) => {
    const e = pending.get(String(id)); if (!e) return false;
    if (typeof text === "string" && text.trim()) e.resolve(text); else e.reject(new Error(String(error || "플러그인이 빈 응답을 보냈어요").slice(0, 300)));
    return true;
  };
  // 가져가길 기다리는 요청이 15초 넘게 있으면 '플러그인을 기다리는 중'
  const waiting = () => { for (const e of pending.values()) if ((!e.claimedAt || now() - e.claimedAt > reclaimMs(e)) && now() - e.at > 15000) return true; return false; };
  return { call, claim, result, waiting };
}

// 프리셋 호출: 플러그인과 같은 모델 호출 코드(Atelier llm-client.js를 묶은 엔진의 callWriterModel)를 그대로 쓴다.
// 그래서 Vertex(서비스 계정 서명)·Copilot(토큰 교환)·Google·추론 설정·추가 JSON이 기기와 똑같이 동작한다. 키는 요청에 실려 오고 이 작업 동안만 메모리에 둔다.
function createPresetCall(E, spec, fetchImpl) {
  const preset = spec.preset, key = typeof spec.key === "string" ? spec.key : "";
  const keyStore = { has: () => Boolean(key), use: async (_p, cb) => { if (!key) throw new Error("서버에 모델 API 키가 전달되지 않았어요"); return cb(key); } };   // 한 작업 동안 같은 객체(Copilot 토큰 캐시가 이 객체에 붙는다)
  const api = { nativeFetch: (u, init) => fetchImpl(u, init) };
  return async (messages, pick, signal) => {
    const { prompt, wrapped } = E.toPrompt(messages);
    return E.fromReply(await E.callWriterModel(api, keyStore, preset, prompt, { signal, stageLabel: "AI" }), wrapped);
  };
}

function createAnalysis({ mem, backupDir = null, engineFile = path.join(__dirname, "engine", "atelier-engine.mjs"), fetchImpl = globalThis.fetch, log = () => {}, loadEngine = null }) {
  let engine = null;
  const available = () => Boolean(loadEngine) || fs.existsSync(engineFile);
  const load = async () => engine ??= await (loadEngine ? loadEngine() : import(pathToFileURL(engineFile).href));
  let job = null, ctrl = null, seq = 0;

  const publicJob = (j) => j && { id: j.id, state: j.state, total: j.total, done: j.done, failed: j.failed, reasons: j.reasons, ...(j.relay ? { relay: true, waiting: j.relay.waiting() } : {}), startedAt: j.startedAt, finishedAt: j.finishedAt ?? null, error: j.error ?? null, chaId: j.chaId, chatId: j.chatId, ...(j.result ? { result: j.result } : {}) };
  // claim: 중계 모드에서 플러그인이 해 줄 모델 호출을 같이 내준다(한 번 내준 요청은 다시 안 준다)
  const status = ({ claim = false } = {}) => ({ available: available(), job: publicJob(job), ...(claim && job?.relay ? { calls: job.relay.claim() } : {}) });
  const relayResult = (b) => { if (!job?.relay) throw fail(409, "중계 분석 중이 아니에요"); return { ok: true, accepted: job.relay.result(b?.callId, { text: b?.text, error: b?.error }) }; };

  async function start(req) {
    if (!available()) throw fail(501, "분석 엔진 파일(engine/atelier-engine.mjs)이 없어요. Cellar를 업데이트해 주세요");
    if (job && job.state === "running") throw fail(409, "이미 분석 중이에요");
    const chaId = String(req?.chaId ?? ""), chatId = String(req?.chatId ?? "");
    if (!chaId || !chatId) throw fail(400, "chaId·chatId가 필요해요");
    if (!Array.isArray(req.messages) || !req.messages.length) throw fail(400, "messages가 비었어요");
    if (req.messages.length > MAX_MESSAGES) throw fail(413, "메시지가 너무 많아요");
    const relay = req.model?.kind === "relay" ? createRelay({ maxWaitSec: Number(req.model.relayWaitSec) > 0 ? Number(req.model.relayWaitSec) : 0 }) : null;
    const isPreset = req.model?.kind === "preset";
    if (isPreset) {
      const pr = req.model.preset;
      if (!pr || typeof pr !== "object" || pr.provider === "risuai" || typeof pr.model !== "string" || !pr.model || typeof pr.baseUrl !== "string" || !pr.baseUrl) throw fail(400, "모델 프리셋이 올바르지 않아요");
    }
    const call = relay ? relay.call : isPreset ? null : createModelCall(req.model, fetchImpl);
    const messages = req.messages.map(slimMessage);
    const settings = req.settings && typeof req.settings === "object" ? req.settings : {};
    const botState = req.bot && typeof req.bot === "object" ? req.bot : {};
    const names = Array.isArray(req.userNames) ? req.userNames.map(String).filter(Boolean).slice(0, 20) : [];
    const rx = Array.isArray(req.regex) ? req.regex : [];
    const range = { from: Number(req.range?.from) || 0, to: req.range?.to != null && Number.isFinite(Number(req.range.to)) ? Number(req.range.to) : Infinity, ...(req.range?.all ? { all: true } : {}) };
    const j = job = { relay, id: `a${++seq}-${Date.now().toString(36)}`, state: "running", total: 0, done: 0, failed: 0, reasons: [], startedAt: Date.now(), chaId, chatId };
    ctrl = new AbortController();
    run(j, { chaId, chatId, messages, settings, botState, names, rx, range, call, spec: isPreset ? req.model : null, charName: String(req.charName ?? "").slice(0, 160), chatName: String(req.chatName ?? "").slice(0, 160), prompts: req.prompts ?? null, redo: Boolean(req.redo), retryMs: Number(req.retryMs) >= 0 ? Number(req.retryMs) : 2000 }, ctrl.signal)
      .catch((e) => { j.state = "error"; j.error = String(e?.message ?? e).slice(0, 300); j.finishedAt = Date.now(); log(`분석 실패: ${j.error}`); });
    return publicJob(j);
  }

  async function run(j, p, signal) {
    const E = await load();
    // 인덱스(설정·봇 목록)는 플러그인이 보낸 것을 이 작업 안에서만 쓴다. 기억 폴더(dusk.mem.v3.f.*)만 Cellar 저장소에 쓴다.
    let indexRaw = null;
    const revs = new Map();
    const storage = {
      getItem: async (k) => {
        if (k === E.INDEX_KEY) return indexRaw;
        const g = mem.get(k); if (!g) { revs.set(k, 0); return null; }
        revs.set(k, g.rev); return g.value;
      },
      setItem: async (k, v) => {
        if (k === E.INDEX_KEY) { indexRaw = v; return; }
        try { const r = mem.put(k, v, { baseRev: revs.get(k) ?? 0 }); revs.set(k, r.rev); }
        catch (e) { revs.delete(k); store.dropCache(); if (e.conflict) throw new Error("busy: 다른 곳에서 먼저 바뀌어서 다시 시도해요"); throw e; }
      },
      removeItem: async (k) => { if (k !== E.INDEX_KEY) mem.del(k); }
    };
    const store = E.createMemoryStoreV3({}, { storage });
    // 기억 손실 방지 ① 다른 곳(플러그인)이 같은 폴더를 먼저 바꿔 충돌하면, 모델 호출을 다시 하지 않고 '새로 읽은 폴더에 결과를 다시 적용'한다
    const baseUpdate = store.updateFolder;
    store.updateFolder = async (...a) => {
      for (let i = 0; ; i++) {
        try { return await baseUpdate(...a); }
        catch (e) { if (!/^busy:/.test(String(e?.message)) || i >= 12) throw e; store.dropCache(); await new Promise((r) => setTimeout(r, 15 * (i + 1))); }
      }
    };
    // ② 시작 전 폴더 사본을 남긴다(최근 5개). 문제가 생기면 이 파일의 value를 dusk.mem 키에 되돌리면 된다
    try {
      const key = E.FOLDER_PREFIX + E.folderIdOf(p.chaId, p.chatId), cur = mem.get(key);
      if (cur && backupDir) {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(backupDir, `${j.id}.json`), JSON.stringify({ key, rev: cur.rev, at: Date.now(), value: cur.value }), { mode: 0o600 });
        const old = fs.readdirSync(backupDir).filter((f) => f.endsWith(".json")).sort(); for (const f of old.slice(0, Math.max(0, old.length - 5))) fs.rmSync(path.join(backupDir, f), { force: true });
      }
    } catch (e) { log(`분석 전 백업 실패(계속 진행): ${e.message}`); }
    const indexSeed = { settings: p.settings, bots: { [p.chaId]: { on: true, ignore: [], fails: 0, ...p.botState } } };
    await store.updateIndex((idx) => { Object.assign(idx.settings, p.settings); Object.assign(idx.bots, indexSeed.bots); });
    const character = { chaId: p.chaId, name: p.charName || "캐릭터", chats: [] };
    const chat = { id: p.chatId, name: p.chatName, message: p.messages };
    character.chats = [chat];
    const api = {
      getCharacterFromIndex: async () => character,
      getChatFromIndex: async () => chat,
      getDatabase: async () => ({ username: p.names[0], personas: p.names.slice(1).map((name) => ({ name })) })
    };
    const runner = E.createMemoryRunner(api, {
      store, call: p.call ?? createPresetCall(E, p.spec, fetchImpl), retryMs: p.retryMs, log: (...a) => log(a.join(" ")),
      prep: { entriesFor: async () => p.rx }, prompts: async () => p.prompts
    });
    const out = await runner.backfill(0, 0, p.range, {
      signal, redo: p.redo,
      onProgress: (n, total, failed) => { j.done = n; j.total = total; j.failed = failed; }
    });
    j.total = out.total; j.failed = out.failed.length; j.reasons = out.reasons;
    const idx = await store.getIndex();
    j.result = { folder: idx.folders?.[Object.keys(idx.folders ?? {}).find((k) => k.includes(p.chatId))] ?? null, bots: idx.bots?.[p.chaId] ?? null, status: idx.status ?? null };
    j.state = signal.aborted ? "cancelled" : "done"; j.finishedAt = Date.now();
    log(`분석 ${j.state}: ${j.done}/${j.total} (실패 ${j.failed})`);
  }

  function cancel() { if (job?.state === "running") { ctrl?.abort(); return { ok: true, cancelling: true }; } return { ok: true, cancelling: false }; }
  return { available, status, start, cancel, relayResult };
}
module.exports = { createAnalysis, createModelCall, createRelay, slimMessage };
