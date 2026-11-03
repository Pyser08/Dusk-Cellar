// 플러그인 수정 — Dusk Cellar가 리스에 설치된 플러그인의 코드를 대신 고친다.
//
// 왜 Cellar가 하나: 리스는 플러그인이 다른 플러그인을 고치지 못하게 막았다(RisuAI PR #1572, plugins 필드 읽기 전용).
// 지금은 RisuBard만 지원한다(호스트별 방식이 다르다. PocketRisu·원본 RisuAI는 다음 단계).
//
// RisuBard 방식(소스 조사: rpaddict/RisuBard, 실기기 확인 전):
//   · 플러그인 목록(db.plugins)은 <세이브>/settings/app.json 에 있고, 인자 이름에 key·token 같은 말이 들어 있으면
//     배열째 <세이브>/secrets/credentials.json 으로 간다. 파일마다 .sha256 사이드카가 있다.
//   · 파일을 바깥에서 고치면 리스가 지문(크기·mtime·사이드카)이 달라진 걸 알아채고 '검토 대기'로 둔다.
//     /api/external-changes/resolve {decision:"accept"}로 받아들이면 리스가 새 파일을 읽어 들인다(DB 덮어쓰기 없음).
//   · 인증: <세이브>/__password 를 읽어 /api/login → JWT(risu-auth). 쓰기는 x-session-id 가 필요하다(새 세션을 등록해 쓴다).
//
// 순서(쓰기 전에 모두 확인한다): 입력·해시 확인 → 로그인·세션 → 검토 대기 없음 확인 → 파일 스냅샷 → 파일 쓰기(사이드카 포함)
//   → 바뀐 파일이 우리 것뿐인지 확인 → accept → 결과 확인.
// 쓴 뒤에 실패하면 되돌리지 않고(리스 지문이 mtime을 보므로 되돌려도 '검토 대기'가 남는다) 쓴 상태 그대로 두고 알린다. 스냅샷은 항상 남는다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const MAX_EDITS = 20;           // 한 번에 고칠 수 있는 플러그인 수
const MAX_SCRIPT = 12 * 1024 * 1024;
const SNAP_KEEP = 20;
const SETTINGS = "settings/app.json", SECRETS = "secrets/credentials.json";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });

// 세이브 폴더의 모양으로 호스트를 구분한다: risubard | pocketrisu | risuai | unknown
function detectHost(saveDir) {
  try {
    if (!saveDir || !fs.statSync(saveDir).isDirectory()) return "unknown";
    const has = (rel) => fs.existsSync(path.join(saveDir, rel));
    if (has(SETTINGS) || has("index/sidebar.json")) return "risubard";
    if (has("risuai.db")) return "pocketrisu";
    if (fs.readdirSync(saveDir).some((n) => /^[0-9a-f]{8,}$/i.test(n))) return "risuai";
  } catch { /* 없음 */ }
  return "unknown";
}

function atomicWrite(file, text) {
  const tmp = `${file}.cellar-${process.pid}-${crypto.randomBytes(3).toString("hex")}.tmp`;
  let mode = 0o644; try { mode = fs.statSync(file).mode & 0o777; } catch { /* 새 파일 */ }
  const fd = fs.openSync(tmp, "w", mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 무시 */ } throw e; }
}

// 원래 파일의 들여쓰기·줄바꿈을 따라 JSON을 다시 쓴다(고치지 않은 부분의 모양이 크게 달라지지 않게)
function serialize(obj, original) {
  const m = /^\{\r?\n([ \t]+)"/.exec(original);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let out = m ? JSON.stringify(obj, null, m[1]) : JSON.stringify(obj);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  return /\r?\n$/.test(original) ? out + eol : out;
}

function createPlugins({ saveDir, dataDir, risuUrl, log = () => {}, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const snapRoot = path.join(dataDir, "plugin-backups");
  let seq = 0, tail = Promise.resolve();
  const serial = (fn) => { const run = tail.then(fn); tail = run.catch(() => {}); return run; };

  const need = () => { const host = detectHost(saveDir); if (host !== "risubard") throw fail(501, host === "unknown" ? "세이브 폴더를 알아볼 수 없어서 플러그인을 고칠 수 없어요" : "이 호스트는 아직 플러그인 수정을 지원하지 않아요(지금은 RisuBard만)", { host }); return host; };

  // plugins가 들어 있는 파일(settings 또는 secrets)을 찾는다
  function load() {
    const found = [];
    for (const [where, rel] of [["settings", SETTINGS], ["secrets", SECRETS]]) {
      const file = path.join(saveDir, rel);
      let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw fail(500, `${rel}을 읽지 못했어요: ${e.message}`); }
      let obj; try { obj = JSON.parse(text); } catch { throw fail(500, `${rel}이 올바른 JSON이 아니에요`); }
      if (obj && typeof obj === "object" && Array.isArray(obj.plugins)) found.push({ where, rel, file, text, obj });
    }
    if (found.length > 1) throw fail(409, "plugins가 두 파일에 모두 있어서 안전하게 고칠 수 없어요");
    return found[0] ?? null;
  }
  const summary = (p, index) => ({
    index, name: String(p?.name ?? ""), displayName: p?.displayName ? String(p.displayName) : undefined, version: p?.version ?? null,
    versionOfPlugin: p?.versionOfPlugin ?? null, enabled: p?.enabled !== false, alias: typeof p?.alias === "string" ? p.alias : undefined, updateURL: p?.updateURL ? String(p.updateURL) : undefined,
    bytes: Buffer.byteLength(String(p?.script ?? "")), sha256: sha256(String(p?.script ?? "")),
    argNames: Object.keys(p?.arguments ?? {}),   // 인자 이름만. 값(realArg)은 비밀일 수 있어 주지 않는다
  });

  async function list() {
    const host = need();
    const f = load();
    return { ok: true, host, location: f?.where ?? "settings", listSha: f ? sha256(JSON.stringify(f.obj.plugins)) : "", plugins: (f?.obj.plugins ?? []).map(summary) };
  }
  function pick(plugins, { name, index }) {
    const hits = plugins.map((p, i) => [p, i]).filter(([p, i]) => p?.name === name && (index === undefined || i === index));
    if (!hits.length) throw fail(404, `'${name}' 플러그인이 없어요`);
    if (hits.length > 1) throw fail(400, `'${name}' 이름이 둘 이상이에요. index를 함께 보내 주세요`);
    return hits[0];
  }
  async function get({ name, index, gzip }) {
    need();
    const f = load();
    const [p, i] = pick(f?.obj.plugins ?? [], { name: String(name ?? ""), index: Number.isInteger(index) ? index : undefined });
    const script = String(p.script ?? "");
    // gzip: 리스 프록시는 응답을 조각조각 넘겨서 큰 코드(수 MB)는 오래 걸린다 → 압축해서(코드는 5~10배 줄어든다) 보내면 빨라진다
    if (gzip) return { ok: true, name: p.name, index: i, scriptZ: zlib.gzipSync(Buffer.from(script, "utf8")).toString("base64"), sha256: sha256(script) };
    return { ok: true, name: p.name, index: i, script, sha256: sha256(script) };
  }

  // scriptZ(gzip+base64)로 온 코드는 풀어서 script로 바꾼다(최대 MAX_SCRIPT까지만 풀어서 압축 폭탄을 막는다)
  function inflateEdit(e) {
    if (!e || typeof e.scriptZ !== "string") return e;
    let buf; try { buf = zlib.gunzipSync(Buffer.from(e.scriptZ, "base64"), { maxOutputLength: MAX_SCRIPT + 1 }); } catch { throw fail(400, `'${e.name}'의 압축된 코드를 풀지 못했어요`); }
    const { scriptZ, ...rest } = e;
    return { ...rest, script: buf.toString("utf8") };
  }
  // 입력 모양 확인
  function validate(edits) {
    if (!Array.isArray(edits) || !edits.length) throw fail(400, "고칠 플러그인이 없어요");
    if (edits.length > MAX_EDITS) throw fail(400, `한 번에 ${MAX_EDITS}개까지만 고칠 수 있어요`);
    const seen = new Set();
    edits = edits.map((e) => inflateEdit(e));
    return edits.map((e) => {
      if (!e || typeof e.name !== "string" || !e.name) throw fail(400, "플러그인 이름이 없어요");
      if (typeof e.script !== "string" || !e.script.trim()) throw fail(400, `'${e.name}'의 코드가 비어 있어요`);
      if (Buffer.byteLength(e.script) > MAX_SCRIPT) throw fail(413, `'${e.name}'의 코드가 너무 커요`);
      if (typeof e.expectSha !== "string" || !/^[0-9a-f]{64}$/i.test(e.expectSha)) throw fail(400, `'${e.name}'의 expectSha(지금 코드의 sha256)가 필요해요`);
      if (e.index !== undefined && !Number.isInteger(e.index)) throw fail(400, "index는 정수예요");
      const key = `${e.name}\0${e.index ?? ""}`;
      if (seen.has(e.name) || seen.has(key)) throw fail(400, `'${e.name}'을(를) 두 번 고칠 수 없어요`);
      seen.add(e.name); seen.add(key);
      return { name: e.name, index: e.index, expectSha: e.expectSha.toLowerCase(), script: e.script };
    });
  }
  // 지금 파일 기준으로 고칠 위치·해시·머리말을 확인하고 새 파일 내용을 만든다
  function plan(edits) {
    const f = load();
    if (!f) throw fail(404, "설치된 플러그인 목록을 찾지 못했어요");
    const plugins = f.obj.plugins.map((p) => ({ ...p }));
    const results = [];
    for (const e of edits) {
      const [p, i] = pick(plugins, e);
      const cur = sha256(String(p.script ?? ""));
      if (cur !== e.expectSha) throw fail(409, `'${e.name}'의 코드가 그새 바뀌었어요. 다시 불러와 주세요`, { conflict: true, currentSha: cur, name: e.name });
      const header = /^[ \t]*\/\/@name[ \t]+(.+?)[ \t]*\r?$/m.exec(e.script)?.[1];
      if (header !== p.name) throw fail(400, `'${e.name}'의 머리말 //@name이 ${header ? `'${header}'로 바뀌었어요` : "없어요"}. 이름을 바꾸면 플러그인 저장소·업데이트가 끊겨요`);
      plugins[i] = { ...p, script: e.script };
      results.push({ name: p.name, index: i, oldSha: cur, newSha: sha256(e.script), bytes: Buffer.byteLength(e.script) });
    }
    const next = { ...f.obj, plugins };
    return { f, results, text: serialize(next, f.text) };
  }

  // 고치기 전 그 파일(과 사이드카)을 복사해 둔다. 20개까지만 남긴다.
  function snapshot(f, results) {
    const d = now();
    const stamp = d.toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "") + String(d.getMilliseconds()).padStart(3, "0");
    const id = `${stamp}-${(seq++).toString(36).padStart(3, "0")}`;
    const dir = path.join(snapRoot, id);
    const dest = path.join(dir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(f.file, dest);
    if (fs.existsSync(f.file + ".sha256")) fs.copyFileSync(f.file + ".sha256", dest + ".sha256");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ at: d.toISOString(), host: "risubard", file: f.rel, edits: results }, null, 2));
    try { for (const old of fs.readdirSync(snapRoot).sort().slice(0, -SNAP_KEEP)) fs.rmSync(path.join(snapRoot, old), { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
    return id;
  }

  // ── 리스(RisuBard) 호출 ──
  async function risu(method, p, { body, headers, timeout = 20000 } = {}) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetchImpl(risuUrl + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
      let json = null; try { json = await res.json(); } catch { /* JSON 아님 */ }
      return { status: res.status, json };
    } catch (e) { throw fail(424, `리스 서버에 연결하지 못했어요(${risuUrl}): ${e.name === "AbortError" ? "응답이 없어요" : e.message}`); } finally { clearTimeout(t); }
  }
  async function connect() {
    let pw = ""; try { pw = fs.readFileSync(path.join(saveDir, "__password"), "utf8").trim(); } catch { /* 아래에서 */ }
    if (!pw) throw fail(424, "리스 암호 파일(__password)을 읽지 못했어요. 리스에 암호가 설정돼 있어야 고칠 수 있어요");
    const login = await risu("POST", "/api/login", { body: { password: pw } });
    if (login.status !== 200 || !login.json?.token) throw fail(424, `리스 로그인에 실패했어요(응답 ${login.status})`);
    const token = login.json.token;
    const session = async () => {
      const id = `cellar-${crypto.randomBytes(6).toString("hex")}`;
      const h = { "risu-auth": token, "x-session-id": id };
      const r = await risu("POST", "/api/session", { headers: h });
      if (r.status !== 200) throw fail(424, `리스 세션을 만들지 못했어요(응답 ${r.status})`);
      return h;
    };
    let headers = await session();
    return {
      pending: async () => { const r = await risu("GET", "/api/external-changes", { headers }); if (r.status !== 200) throw fail(424, `리스의 외부 변경 상태를 읽지 못했어요(응답 ${r.status})`); return r.json?.pending ?? null; },
      resolve: (revision) => risu("POST", "/api/external-changes/resolve", { headers, body: { decision: "accept", revision }, timeout: 120000 }),
      renew: async () => { headers = await session(); },
    };
  }

  // 파일을 고치는 공통 흐름: planFn()은 지금 파일 기준으로 { f, results, text }를 만든다(두 번 불린다: 리스를 부르기 전·쓰기 직전)
  function commit(planFn, label) {
    return serial(async () => {
      need();
      planFn();                                     // 리스를 부르기 전에 빠르게 확인
      const conn = await connect();
      if (await conn.pending()) throw fail(409, "리스에 검토 대기 중인 외부 변경이 있어요. 리스 화면에서 먼저 처리한 뒤 다시 해 주세요", { pending: true });
      const { f, results, text } = planFn();      // 로그인하는 사이 바뀌었을 수 있어 쓰기 직전에 다시 확인
      const snap = snapshot(f, results);
      try {
        atomicWrite(f.file, text);
        atomicWrite(f.file + ".sha256", sha256(text) + "\n");
      } catch (e) {
        // 쓰다가 실패: 원래 파일로 되돌린다(스냅샷에서)
        try { fs.copyFileSync(path.join(snapRoot, snap, f.rel), f.file); if (fs.existsSync(path.join(snapRoot, snap, f.rel + ".sha256"))) fs.copyFileSync(path.join(snapRoot, snap, f.rel + ".sha256"), f.file + ".sha256"); } catch { /* 스냅샷은 남아 있다 */ }
        throw fail(500, `파일을 쓰지 못했어요: ${e.message}`, { written: false, snapshot: snap });
      }
      log(`플러그인 ${label}: ${results.map((r) => r.name).join(", ")} → ${f.rel} (스냅샷 ${snap})`);
      const after = { written: true, snapshot: snap, file: f.rel };
      let adopted = false, reload = false;
      for (let attempt = 0; attempt < 2 && !adopted; attempt++) {
        const pend = await conn.pending().catch((e) => { throw fail(502, `파일은 고쳤지만 리스 상태를 확인하지 못했어요: ${e.message}. 리스 화면에서 외부 변경을 받아들여 주세요`, after); });
        if (!pend) throw fail(502, "파일은 고쳤지만 리스가 바뀐 걸 알아채지 못했어요. 리스를 새로고침하거나 다시 시작한 뒤 확인해 주세요", { ...after, undetected: true });
        const paths = (pend.changes ?? []).map((c) => String(c.path ?? c.id ?? ""));
        const others = paths.filter((x) => x !== f.rel);
        if (others.length || (pend.errors ?? []).length) throw fail(409, "파일은 고쳤지만, 다른 파일도 바뀌어 있어서 자동으로 받아들이지 않았어요. 리스 화면의 '외부 변경 검토'에서 확인해 주세요", { ...after, others, errors: pend.errors ?? [] });
        const r = await conn.resolve(pend.revision);
        if (r.status === 200 && r.json?.resolved) { adopted = true; reload = r.json.reload === true; break; }
        if (r.status === 200) break;                                           // resolved:false — 더 받아들일 게 없다
        if (attempt === 0 && r.status === 423) { await conn.renew(); continue; }   // 세션이 밀렸으면 새 세션으로 한 번 더
        if (attempt === 0 && r.status === 409 && r.json?.code === "EXTERNAL_CHANGES_CHANGED") continue;   // 그새 바뀜 — 다시 확인
        throw fail(502, `파일은 고쳤지만 리스가 받아들이지 못했어요(응답 ${r.status}${r.json?.error ? `: ${r.json.error}` : ""}). 리스 화면의 '외부 변경 검토'에서 받아들여 주세요`, after);
      }
      const left = await conn.pending().catch(() => null);
      return { ok: true, host: "risubard", file: f.rel, snapshot: snap, results, adopted, reload, stillPending: Boolean(left), needsReload: true };
    });
  }


  async function apply({ edits } = {}) {
    const list = validate(edits);
    return commit(() => plan(list), "수정");
  }

  // ── 일반 수정(켜짐·이름·별칭·인자값·순서·추가·삭제·통째 바꾸기) ──
  const SET_KEYS = { enabled: "boolean", displayName: "string", alias: "string", realArg: "object", arguments: "object", customLink: "array", argMeta: "object", versionOfPlugin: "string", updateURL: "string", __pmPresets__: "object" };
  const typeOk = (v, t) => (t === "array" ? Array.isArray(v) : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === t);
  const listSha = (plugins) => sha256(JSON.stringify(plugins));
  function checkNew(pl) {
    if (!pl || typeof pl !== "object" || typeof pl.name !== "string" || !pl.name) throw fail(400, "추가할 플러그인에 이름이 없어요");
    if (typeof pl.script !== "string" || !pl.script.trim()) throw fail(400, `'${pl.name}'의 코드가 비어 있어요`);
    if (Buffer.byteLength(pl.script) > MAX_SCRIPT) throw fail(413, `'${pl.name}'의 코드가 너무 커요`);
    const header = /^[ \t]*\/\/@name[ \t]+(.+?)[ \t]*\r?$/m.exec(pl.script)?.[1];
    if (header !== pl.name) throw fail(400, `'${pl.name}'의 머리말 //@name이 ${header ? `'${header}'` : "없어요"}`);
    return { enabled: true, version: "3.0", versionOfPlugin: "", updateURL: "", arguments: {}, realArg: {}, customLink: [], argMeta: {}, displayName: pl.name, ...pl };
  }
  function planOps(ops, expectListSha) {
    const f = load();
    if (!f) throw fail(404, "설치된 플러그인 목록을 찾지 못했어요");
    let plugins = f.obj.plugins.map((p) => ({ ...p }));
    if (expectListSha && listSha(f.obj.plugins) !== expectListSha) throw fail(409, "그새 플러그인 목록이 바뀌었어요. 새로고침한 뒤 다시 해 주세요", { conflict: true, listChanged: true });
    const results = [];
    for (const o of ops) {
      if (!o || typeof o.op !== "string") throw fail(400, "알 수 없는 작업이에요");
      if (o.op === "set") {
        const [p, i] = pick(plugins, o);
        const fields = o.fields && typeof o.fields === "object" ? o.fields : {};
        const next = { ...p };
        for (const [k, v] of Object.entries(fields)) {
          if (!(k in SET_KEYS)) throw fail(400, `'${k}'은(는) 고칠 수 없는 항목이에요`);
          if (v === null && k === "alias") { delete next[k]; continue; }
          if (!typeOk(v, SET_KEYS[k])) throw fail(400, `'${k}'의 형식이 맞지 않아요(${SET_KEYS[k]})`);
          next[k] = v;
        }
        plugins[i] = next;
        results.push({ op: "set", name: p.name, index: i, fields: Object.keys(fields) });
      } else if (o.op === "remove") {
        const [p, i] = pick(plugins, o);
        plugins.splice(i, 1);
        results.push({ op: "remove", name: p.name, index: i });
      } else if (o.op === "add") {
        const pl = checkNew(o.plugin);
        const same = plugins.map((p, i) => [p, i]).filter(([p]) => p?.name === pl.name);
        if (same.length && !o.replace) throw fail(409, `'${pl.name}' 플러그인이 이미 있어요`, { exists: true, name: pl.name });
        if (same.length) {
          const [old, i] = same[0];
          const keep = o.keepSettings !== false;   // 기본: 켜짐·별칭·순서·같은 이름·타입의 인자값을 유지
          const merged = { ...pl };
          if (keep) {
            merged.enabled = old.enabled !== false;
            if (old.alias !== undefined) merged.alias = old.alias;
            const realArg = {};
            for (const [k, t] of Object.entries(pl.arguments ?? {})) if (old.arguments?.[k] === t && old.realArg && k in old.realArg) realArg[k] = old.realArg[k];
            merged.realArg = { ...(pl.realArg ?? {}), ...realArg };
            if (old.__pmPresets__ !== undefined) merged.__pmPresets__ = old.__pmPresets__;
          }
          plugins[i] = merged;
          results.push({ op: "replace", name: pl.name, index: i });
        } else {
          const at = Number.isInteger(o.position) ? Math.max(0, Math.min(plugins.length, o.position)) : plugins.length;
          plugins.splice(at, 0, pl);
          results.push({ op: "add", name: pl.name, index: at });
        }
      } else if (o.op === "order") {
        if (!Array.isArray(o.order) || o.order.length !== plugins.length || new Set(o.order).size !== plugins.length || o.order.some((i) => !Number.isInteger(i) || i < 0 || i >= plugins.length)) throw fail(400, "순서가 맞지 않아요(현재 번호를 모두 한 번씩 보내야 해요)");
        plugins = o.order.map((i) => plugins[i]);
        results.push({ op: "order", name: "순서", count: plugins.length });
      } else if (o.op === "replaceAll") {
        if (!Array.isArray(o.plugins)) throw fail(400, "plugins 배열이 필요해요");
        plugins = o.plugins.map((p) => ({ ...checkNew(p) }));
        const names = new Set(); // 통째 바꾸기에서도 같은 이름 두 개는 허용(중복 정리는 따로 한다) — 형식만 확인
        results.push({ op: "replaceAll", name: "전체", count: plugins.length });
      } else throw fail(400, `알 수 없는 작업이에요: ${o.op}`);
    }
    return { f, results, text: serialize({ ...f.obj, plugins }, f.text) };
  }
  async function mutate({ ops, expectListSha } = {}) {
    if (!Array.isArray(ops) || !ops.length) throw fail(400, "할 작업이 없어요");
    if (ops.length > 500) throw fail(400, "한 번에 500개까지만 할 수 있어요");
    if (ops.some((o) => o?.op === "order" || o?.op === "replaceAll") && !expectListSha) throw fail(400, "순서·통째 바꾸기는 expectListSha(목록 해시)가 필요해요");
    ops = ops.map((o) => (o?.plugin?.scriptZ ? { ...o, plugin: inflateEdit(o.plugin) } : o));
    ops = ops.map((o) => (o?.op === "replaceAll" && Array.isArray(o.plugins) ? { ...o, plugins: o.plugins.map((p) => (p?.scriptZ ? inflateEdit(p) : p)) } : o));
    return commit(() => planOps(ops, expectListSha), "변경");
  }
  // 전체 내보내기(백업용): 코드·인자값까지 모두. gzip:true면 JSON 전체를 gzip+base64로 준다
  async function exportAll({ gzip } = {}) {
    need();
    const f = load();
    if (!f) throw fail(404, "설치된 플러그인 목록을 찾지 못했어요");
    const out = { ok: true, listSha: listSha(f.obj.plugins), location: f.where };
    if (gzip) return { ...out, plugins: undefined, pluginsZ: zlib.gzipSync(Buffer.from(JSON.stringify(f.obj.plugins), "utf8")).toString("base64") };
    return { ...out, plugins: f.obj.plugins };
  }

  return { list, get, apply, mutate, exportAll, detect: () => detectHost(saveDir) };
}

module.exports = { createPlugins, detectHost, MAX_EDITS, SNAP_KEEP };
