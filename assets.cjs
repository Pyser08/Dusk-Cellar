"use strict";
// 에셋 빠른 쓰기: 봇·모듈을 가져올 때 이미지·소리 같은 에셋을 리스 서버 저장소에 한꺼번에 넣는다.
//   · risuai(순정): 세이브 폴더에 save/<hex(key)> 파일을 직접 쓴다(임시 파일 → rename, fsync 없음).
//   · risubard / pocketrisu: 같은 PC의 /api/assets/bulk-write 로 묶어서 보낸다(서버가 자기 규칙대로 저장).
// 키는 "assets/<sha256>.<확장자>" 모양만 받는다(이름이 곧 내용의 해시라 중복 확인이 쉽다).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRisuClient, fail } = require("./risu-client.cjs");

const KEY = /^assets\/([a-f0-9]{64})\.([a-z0-9]{1,16})$/;
const MAX_KEYS = 5000, MAX_PUT = 200, BATCH_BYTES = 24 * 1024 * 1024, BATCH_COUNT = 50;
const hexName = (key) => Buffer.from(key, "utf8").toString("hex");

function createAssets({ saveDir, host, risuUrl, altUrls, log = () => {}, fetchImpl = globalThis.fetch }) {
  const client = createRisuClient({ saveDir, risuUrl, fetchImpl, altUrls });
  const sink = host === "risuai" ? "direct" : host === "risubard" || host === "pocketrisu" ? "bulk" : null;
  let tail = Promise.resolve();
  const serial = (fn) => { const r = tail.then(fn, fn); tail = r.catch(() => {}); return r; };
  const need = () => { if (!sink) throw fail(501, "이 세이브 폴더에서는 에셋 쓰기를 쓸 수 없어요"); };
  const checkKeys = (keys) => {
    if (!Array.isArray(keys)) throw fail(400, "keys가 배열이어야 해요");
    if (keys.length > MAX_KEYS) throw fail(413, `한 번에 ${MAX_KEYS}개까지 확인할 수 있어요`);
    for (const k of keys) if (typeof k !== "string" || !KEY.test(k)) throw fail(400, `에셋 키 모양이 아니에요: ${String(k).slice(0, 80)}`);
  };

  async function listRemote(conn) {
    const r = await client.risu("GET", "/api/list", { headers: { ...conn.headers(), "key-prefix": "assets/" } });
    if (r.status !== 200 || !Array.isArray(r.json?.content)) throw fail(424, `리스의 에셋 목록을 읽지 못했어요(응답 ${r.status})`);
    return new Set(r.json.content);
  }
  const onDisk = (key) => {
    const m = KEY.exec(key);
    return fs.existsSync(path.join(saveDir, "asset-store", m[1].slice(0, 2), `${m[1]}.${m[2]}`));
  };

  async function missing({ keys }) {
    need(); checkKeys(keys);
    const uniq = [...new Set(keys)];
    if (sink === "direct") return { missing: uniq.filter((k) => !fs.existsSync(path.join(saveDir, hexName(k)))) };
    const conn = await client.connect();
    const have = await listRemote(conn);
    return { missing: uniq.filter((k) => !have.has(k) && !(host === "risubard" && onDisk(k))) };
  }

  function putDirect(entries) {
    let written = 0;
    for (const e of entries) {
      const file = path.join(saveDir, hexName(e.key)), tmp = `${file}.cellar-${crypto.randomBytes(3).toString("hex")}.tmp`;
      try { fs.writeFileSync(tmp, e.buf); fs.renameSync(tmp, file); written++; }
      catch (err) { try { fs.unlinkSync(tmp); } catch { /* 무시 */ } throw fail(500, `에셋을 쓰지 못했어요: ${err.message}`); }
    }
    return written;
  }
  async function putBulk(entries) {
    let conn = await client.connect(), written = 0, i = 0;
    while (i < entries.length) {
      const batch = []; let bytes = 0;
      while (i < entries.length && batch.length < BATCH_COUNT && (batch.length === 0 || bytes + entries[i].buf.length <= BATCH_BYTES)) { bytes += entries[i].buf.length; batch.push(entries[i++]); }
      const body = JSON.stringify(batch.map((e) => ({ key: e.key, value: e.buf.toString("base64") })));
      let r = await client.risu("POST", "/api/assets/bulk-write", { headers: conn.headers(), raw: body, timeout: 120000 });
      if (r.status === 423) { await conn.renew(); r = await client.risu("POST", "/api/assets/bulk-write", { headers: conn.headers(), raw: body, timeout: 120000 }); }
      if (r.status !== 200) throw fail(424, `리스에 에셋을 쓰지 못했어요(응답 ${r.status}): ${r.json?.error ?? ""}`, { written });
      written += batch.length;
    }
    return written;
  }

  // entries: [{ key, value(base64) }]. 해시가 이름과 맞지 않으면 거부한다.
  function put({ entries }) {
    return serial(async () => {
      need();
      if (!Array.isArray(entries) || !entries.length) throw fail(400, "entries가 비어 있어요");
      if (entries.length > MAX_PUT) throw fail(413, `한 번에 ${MAX_PUT}개까지 쓸 수 있어요`);
      checkKeys(entries.map((e) => e?.key));
      const list = entries.map((e) => {
        const buf = Buffer.from(String(e.value ?? ""), "base64");
        if (crypto.createHash("sha256").update(buf).digest("hex") !== KEY.exec(e.key)[1]) throw fail(400, `내용이 키의 해시와 달라요: ${e.key.slice(0, 40)}…`);
        return { key: e.key, buf };
      });
      const written = sink === "direct" ? putDirect(list) : await putBulk(list);
      log(`assets put ${written} (${sink})`);
      return { written, sink };
    });
  }
  const status = () => ({ ok: !!sink, host, sink });
  return { status, missing, put };
}
module.exports = { createAssets, KEY };
