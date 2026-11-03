// Dusk Cellar 기억 저장소 — 플러그인이 보낸 기억(키-값)을 파일로 보관한다.
//
// · 키마다 파일 하나: dusk-data/mem/<키의 sha256>.mem
//   첫 줄 = 메타(JSON: key·rev·updatedAt·size·ops), 그다음부터 = 값(플러그인이 보낸 문자열 그대로)
// · rev: 쓸 때마다 1씩 오른다. baseRev를 주면 "내가 본 rev가 지금도 그대로일 때만" 쓴다(다른 기기와 덮어쓰기 방지).
// · opId: 같은 쓰기를 다시 보내도(연결이 끊겼다 재전송) 한 번만 반영된다. 키마다 최근 16개를 기억한다.
// · 하루 첫 쓰기 전에 mem 폴더 통째로 dusk-data/snapshots/<날짜>/ 에 복사하고, 7일치만 남긴다.
// · Node 기본 기능만 쓴다. 쓰기는 임시 파일 → 이름 바꾸기로 중간에 끊겨도 깨지지 않는다.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const KEY_RE = /^dusk\.mem\.[A-Za-z0-9._:@-]{1,200}$/;
const MAX_VALUE = 16 * 1024 * 1024;
const OPS_KEPT = 16;
const SNAP_KEEP = 7;
const HEAD_READ = 8192;

const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function createStore({ dir, now = () => new Date(), log = () => {} }) {
  const memDir = path.join(dir, "mem");
  const snapDir = path.join(dir, "snapshots");
  fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
  const fileOf = (key) => path.join(memDir, sha(key) + ".mem");
  const index = new Map(); // key → { rev, updatedAt, size, ops }

  // 시작할 때 각 파일의 첫 줄(메타)만 읽어 목록을 만든다. 값은 읽지 않는다.
  for (const name of fs.readdirSync(memDir)) {
    if (!name.endsWith(".mem")) continue;
    try {
      const fd = fs.openSync(path.join(memDir, name), "r");
      const buf = Buffer.alloc(HEAD_READ);
      const n = fs.readSync(fd, buf, 0, HEAD_READ, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, n).toString("utf8");
      const nl = head.indexOf("\n");
      if (nl < 0) throw new Error("메타 줄이 없어요");
      const m = JSON.parse(head.slice(0, nl));
      if (typeof m.key !== "string" || path.join(memDir, sha(m.key) + ".mem") !== path.join(memDir, name)) throw new Error("메타가 안 맞아요");
      index.set(m.key, { rev: m.rev, updatedAt: m.updatedAt, size: m.size, ops: Array.isArray(m.ops) ? m.ops : [] });
    } catch (e) { log(`기억 파일을 건너뛰었어요(${name}): ${e.message}`); }
  }

  const checkKey = (key) => { if (typeof key !== "string" || !KEY_RE.test(key)) throw fail(400, "키 형식이 맞지 않아요"); };
  const checkBase = (base) => {
    if (base === undefined || base === null) return undefined;
    const n = Number(base);
    if (!Number.isInteger(n) || n < 0) throw fail(400, "baseRev는 0 이상의 정수예요");
    return n;
  };
  const conflict = (cur) => fail(409, "다른 곳에서 먼저 바뀌었어요", { conflict: true, rev: cur?.rev ?? 0 });

  // ── 하루 한 번 스냅샷 ──
  let snapDay = "";
  function snapshotIfNeeded() {
    const day = now().toISOString().slice(0, 10);
    if (day === snapDay || index.size === 0) return;
    snapDay = day;
    const target = path.join(snapDir, day);
    if (fs.existsSync(target)) return;
    try {
      fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
      const tmp = target + ".tmp";
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(memDir, tmp, { recursive: true });
      fs.renameSync(tmp, target);
      const days = fs.readdirSync(snapDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      for (const d of days.slice(0, Math.max(0, days.length - SNAP_KEEP))) fs.rmSync(path.join(snapDir, d), { recursive: true, force: true });
    } catch (e) { log("스냅샷을 못 남겼어요:", e.message); }
  }

  function readValue(key) {
    let text;
    try { text = fs.readFileSync(fileOf(key), "utf8"); } catch { return null; }
    const nl = text.indexOf("\n");
    return nl < 0 ? null : text.slice(nl + 1);
  }

  const api = {
    get(key) {
      checkKey(key);
      const m = index.get(key);
      if (!m) return null;
      const value = readValue(key);
      if (value === null) return null;
      return { key, rev: m.rev, updatedAt: m.updatedAt, value };
    },

    list(prefix = "") {
      return [...index.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, m]) => ({ key, rev: m.rev, updatedAt: m.updatedAt, size: m.size }));
    },

    put(key, value, { baseRev, opId } = {}) {
      checkKey(key);
      if (typeof value !== "string") throw fail(400, "value는 문자열이어야 해요");
      const size = Buffer.byteLength(value);
      if (size > MAX_VALUE) throw fail(413, "값이 너무 커요");
      if (opId !== undefined && (typeof opId !== "string" || opId.length > 80)) throw fail(400, "opId 형식이 맞지 않아요");
      const base = checkBase(baseRev);
      const cur = index.get(key);
      const seen = opId ? cur?.ops.find((o) => o.id === opId) : null;
      if (seen) return { ok: true, key, rev: seen.rev, updatedAt: cur.updatedAt, duplicate: true };
      if (base !== undefined && base !== (cur?.rev ?? 0)) throw conflict(cur);
      snapshotIfNeeded();
      const rev = (cur?.rev ?? 0) + 1;
      const ops = [...(cur?.ops ?? []), ...(opId ? [{ id: opId, rev }] : [])].slice(-OPS_KEPT);
      const meta = { key, rev, updatedAt: now().getTime(), size, ops };
      const file = fileOf(key), tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(meta) + "\n" + value, { mode: 0o600 });
      fs.renameSync(tmp, file);
      index.set(key, { rev, updatedAt: meta.updatedAt, size, ops });
      return { ok: true, key, rev, updatedAt: meta.updatedAt };
    },

    del(key, { baseRev } = {}) {
      checkKey(key);
      const base = checkBase(baseRev);
      const cur = index.get(key);
      if (!cur) return { ok: true, key, deleted: false };
      if (base !== undefined && base !== cur.rev) throw conflict(cur);
      snapshotIfNeeded();
      fs.rmSync(fileOf(key), { force: true });
      index.delete(key);
      return { ok: true, key, deleted: true };
    },

    // 여러 쓰기를 차례로. 하나가 실패해도 나머지는 계속하고, 결과는 같은 순서로 돌려준다.
    batch(ops) {
      if (!Array.isArray(ops) || ops.length > 500) throw fail(400, "ops는 500개 이하의 배열이어야 해요");
      return ops.map((o) => {
        try {
          if (o?.op === "put") return api.put(o.key, o.value, o);
          if (o?.op === "del") return api.del(o.key, o);
          throw fail(400, "op는 put 또는 del이에요");
        } catch (e) {
          if (!e.status) throw e;
          return { ok: false, key: o?.key, status: e.status, error: e.message, ...(e.conflict ? { conflict: true, rev: e.rev } : {}) };
        }
      });
    },
  };
  return api;
}

module.exports = { createStore, KEY_RE, MAX_VALUE, SNAP_KEEP };
