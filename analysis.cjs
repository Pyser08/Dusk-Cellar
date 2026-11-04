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
      let body, headers = { "content-type": "application/json", ...(model.headers && typeof model.headers === "object" ? model.headers : {}) };
      if (kind === "anthropic") {
        const sys = messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");
        const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: text(m.content) }));
        body = { model: model.model, max_tokens: model.maxTokens ?? 8192, ...(sys ? { system: sys } : {}), messages: rest, ...(model.temperature != null ? { temperature: model.temperature } : {}) };
        headers = { ...headers, "x-api-key": model.key ?? "", "anthropic-version": "2023-06-01" };
      } else {
        body = { model: model.model, messages: messages.map((m) => ({ role: m.role, content: text(m.content) })), ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}), ...(model.temperature != null ? { temperature: model.temperature } : {}) };
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

function createAnalysis({ mem, engineFile = path.join(__dirname, "engine", "atelier-engine.mjs"), fetchImpl = globalThis.fetch, log = () => {}, loadEngine = null }) {
  let engine = null;
  const available = () => Boolean(loadEngine) || fs.existsSync(engineFile);
  const load = async () => engine ??= await (loadEngine ? loadEngine() : import(pathToFileURL(engineFile).href));
  let job = null, ctrl = null, seq = 0;

  const publicJob = (j) => j && { id: j.id, state: j.state, total: j.total, done: j.done, failed: j.failed, reasons: j.reasons, startedAt: j.startedAt, finishedAt: j.finishedAt ?? null, error: j.error ?? null, chaId: j.chaId, chatId: j.chatId, ...(j.result ? { result: j.result } : {}) };
  const status = () => ({ available: available(), job: publicJob(job) });

  async function start(req) {
    if (!available()) throw fail(501, "분석 엔진 파일(engine/atelier-engine.mjs)이 없어요. Cellar를 업데이트해 주세요");
    if (job && job.state === "running") throw fail(409, "이미 분석 중이에요");
    const chaId = String(req?.chaId ?? ""), chatId = String(req?.chatId ?? "");
    if (!chaId || !chatId) throw fail(400, "chaId·chatId가 필요해요");
    if (!Array.isArray(req.messages) || !req.messages.length) throw fail(400, "messages가 비었어요");
    if (req.messages.length > MAX_MESSAGES) throw fail(413, "메시지가 너무 많아요");
    const call = createModelCall(req.model, fetchImpl);
    const messages = req.messages.map(slimMessage);
    const settings = req.settings && typeof req.settings === "object" ? req.settings : {};
    const botState = req.bot && typeof req.bot === "object" ? req.bot : {};
    const names = Array.isArray(req.userNames) ? req.userNames.map(String).filter(Boolean).slice(0, 20) : [];
    const rx = Array.isArray(req.regex) ? req.regex : [];
    const range = { from: Number(req.range?.from) || 0, to: req.range?.to != null && Number.isFinite(Number(req.range.to)) ? Number(req.range.to) : Infinity, ...(req.range?.all ? { all: true } : {}) };
    const j = job = { id: `a${++seq}-${Date.now().toString(36)}`, state: "running", total: 0, done: 0, failed: 0, reasons: [], startedAt: Date.now(), chaId, chatId };
    ctrl = new AbortController();
    run(j, { chaId, chatId, messages, settings, botState, names, rx, range, call, charName: String(req.charName ?? "").slice(0, 160), chatName: String(req.chatName ?? "").slice(0, 160), prompts: req.prompts ?? null, redo: Boolean(req.redo), retryMs: Number(req.retryMs) >= 0 ? Number(req.retryMs) : 2000 }, ctrl.signal)
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
      store, call: p.call, retryMs: p.retryMs, log: (...a) => log(a.join(" ")),
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
  return { available, status, start, cancel };
}
module.exports = { createAnalysis, createModelCall, slimMessage };
