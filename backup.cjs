// Dusk Cellar 백업 — 리스 세이브 폴더(save/)와 Cellar 기억(dusk-data/mem)을 통째로 스냅샷한다.
//
// 왜 압축(zip)이 아닌가: 세이브의 대부분은 이미 압축된 이미지(에셋)라 다시 압축해도 거의 안 줄고, 수십 GB를
// 매번 압축·해제하면 몇십 분이 걸린다. 대신 '바뀐 파일만' 다룬다.
//   · 백업: 직전 스냅샷과 크기·수정 시각이 같은 파일은 하드링크(디스크·시간 거의 0), 바뀐 파일만 복사.
//     스냅샷 폴더는 Cellar만 만들고 고치지 않으므로 하드링크를 공유해도 안전하다(리스 폴더와는 링크하지 않는다 —
//     리스가 파일을 제자리에서 고쳐 쓰면 백업까지 바뀌기 때문). 복사는 가능하면 reflink(COPYFILE_FICLONE).
//   · 복원: 리스를 멈춘 뒤, 스냅샷과 다른 파일만 바꾸고 스냅샷에 없는 파일은 지운다(바로 직전에 자동 백업을 남김).
// 각 스냅샷은 그 자체로 완전한 폴더라 tar 등으로 그대로 옮길 수 있다: backups/<id>/save, backups/<id>/mem, manifest.json
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ID_RE = /^\d{8}-\d{6}(-\d+)?$/;
const PARALLEL = 16;
// 건드리지 않는 것: RisuBard의 실행 잠금 폴더(복원하면 옛 pid 잠금 때문에 안 켜질 수 있음)
const SKIP_DIRS = new Set([".risubard-server.lock"]);
// SQLite(PocketRisu의 save/risuai.db 등): 도는 중에 파일을 그냥 복사하면 WAL과 어긋나 깨질 수 있다 →
// SQLite 온라인 백업으로 한 파일에 일관되게 담고, -wal·-shm·-journal은 담지 않는다(복원 때는 지워진다).
const SQLITE_SIDE = /-(wal|shm|journal)$/;
const SQLITE_HEAD = Buffer.from("SQLite format 3\0");
function isSqlite(file) {
  try { const fd = fs.openSync(file, "r"); const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return n === 16 && b.equals(SQLITE_HEAD); } catch { return false; }
}
let sqliteMod;
function sqlite() {
  if (sqliteMod === undefined) {
    try { const w = process.emitWarning; process.emitWarning = () => {}; try { sqliteMod = require("node:sqlite"); } finally { process.emitWarning = w; } } catch { sqliteMod = null; }
  }
  return sqliteMod?.backup ? sqliteMod : null;
}
async function sqliteBackup(src, dst) {
  const m = sqlite();
  if (!m) throw Object.assign(new Error("이 Node에는 SQLite 백업 기능이 없어요(Node 22.16 이상 필요)"), { status: 500 });
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rm(dst, { force: true });
  const db = new m.DatabaseSync(src, { readOnly: true });
  try { await m.backup(db, dst); } finally { db.close(); }
}

// 폴더 안의 파일 목록: { "상대/경로": [size, mtimeMs] } — 심볼릭 링크·특수 파일은 건너뛴다
async function scan(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = async (dir, rel) => {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const e of ents) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        try { const st = await fsp.stat(path.join(dir, e.name)); out[r] = [st.size, Math.round(st.mtimeMs)]; } catch (err) { if (err.code !== "ENOENT") throw err; }
      }
    }
  };
  await walk(root, "");
  return out;
}

// 동시에 n개씩
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const stamp = (d) => d.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/^(\d{8})(\d{6}).*/, "$1-$2");

async function copyKeep(src, dst, meta) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst, fs.constants.COPYFILE_FICLONE);
  const t = new Date(meta[1]);
  await fsp.utimes(dst, t, t).catch(() => {});
}

function createBackups({ dataDir, saveDir, memDir = path.join(dataDir, "mem"), keep = 5, now = () => new Date(), log = () => {} }) {
  const root = path.join(dataDir, "backups");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sources = () => [["save", saveDir], ["mem", memDir]];
  let job = null;   // { kind, phase, done, total, bytes, startedAt, error, result }

  const readManifest = (id) => { try { return JSON.parse(fs.readFileSync(path.join(root, id, "manifest.json"), "utf8")); } catch { return null; } };
  const ids = () => fs.readdirSync(root).filter((d) => ID_RE.test(d) && fs.existsSync(path.join(root, d, "manifest.json"))).sort();

  function list() {
    return ids().reverse().map((id) => { const m = readManifest(id); return { id, at: m?.at ?? 0, label: m?.label ?? "", files: m?.count ?? 0, bytes: m?.bytes ?? 0, copied: m?.copied ?? 0, unstable: !!m?.unstable, linked: m?.linked ?? 0, ms: m?.ms ?? 0 }; });
  }

  async function freeBytes(dir) {
    try { const s = await fsp.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
  }
  // 백업이 디스크를 끝까지 채우면 리스 자신이 저장하지 못해 망가진다 → 백업이 끝난 뒤에도 이만큼은 남겨 둔다(2GB 또는 디스크의 5% 중 큰 쪽)
  async function reserveBytes(dir) {
    try { const s = await fsp.statfs(dir); return Math.max(2 * 1024 ** 3, Math.floor(Number(s.blocks) * Number(s.bsize) * 0.05)); } catch { return 2 * 1024 ** 3; }
  }

  // 백업 하나 만들기. 리스가 도는 중이어도 되도록, 복사 중에 바뀐 파일은 한 번 더 훑어 다시 담는다(최대 3번).
  async function create({ label = "" } = {}) {
    const t0 = Date.now();
    let id = stamp(now());
    for (let n = 2; fs.existsSync(path.join(root, id)); n++) id = stamp(now()) + "-" + n;
    const prevId = ids().pop();
    const prev = prevId ? readManifest(prevId) : null;
    const tmp = path.join(root, id + ".tmp");
    // 이전에 중간에 끊긴 백업이 남긴 임시 폴더는 디스크만 차지하므로 치운다(백업은 한 번에 하나만 돌고 복원 중에는 안 돌린다)
    for (const d of fs.readdirSync(root)) if (d.endsWith(".tmp") && d !== id + ".tmp") await fsp.rm(path.join(root, d), { recursive: true, force: true }).catch(() => {});
    if (!fs.existsSync(saveDir) || !fs.statSync(saveDir).isDirectory()) throw Object.assign(new Error(`세이브 폴더를 찾지 못해서 백업하지 않았어요(${saveDir})`), { status: 422 });
    await fsp.rm(tmp, { recursive: true, force: true });
    const manifest = { v: 1, id, at: now().getTime(), label, sources: {}, count: 0, bytes: 0, copied: 0, linked: 0 };
    try {
      for (const [name, src] of sources()) {
        const sqliteFiles = new Set();
        const filterOut = (all) => {
          for (const r of Object.keys(all)) if (!SQLITE_SIDE.test(r) && !sqliteFiles.has(r) && r.endsWith(".db") && isSqlite(path.join(src, r))) sqliteFiles.add(r);
          for (const r of Object.keys(all)) if (SQLITE_SIDE.test(r) && sqliteFiles.has(r.replace(SQLITE_SIDE, ""))) delete all[r];
          return all;
        };
        let files = filterOut(await scan(src));
        // 비어 있는 세이브를 '백업'으로 남기면, 나중에 복원할 때 세이브 전체가 지워진다 → 만들지 않는다
        if (name === "save" && !Object.keys(files).length) throw Object.assign(new Error("세이브 폴더에 파일이 하나도 없어서 백업하지 않았어요(주소가 맞는지 확인해 주세요)"), { status: 422 });
        const before = prev?.sources?.[name] ?? {};
        // SQLite는 온라인 백업으로 먼저(내용이 계속 바뀌므로 링크하지 않고 매번 새로)
        for (const r of sqliteFiles) {
          const dst = path.join(tmp, name, r);
          await sqliteBackup(path.join(src, r), dst);
          const st = await fsp.stat(dst);
          files[r] = [st.size, Math.round(st.mtimeMs)];
          manifest.copied++;
        }
        const got = Object.fromEntries([...sqliteFiles].map((r) => [r, files[r]]));
        // 디스크 확인: 새로 복사할 양 + 여유 64MB
        const need = Object.entries(files).reduce((n, [r, m]) => n + (same(m, before[r]) ? 0 : m[0]), 0);
        const free = await freeBytes(root);
        if (need + await reserveBytes(root) > free) throw Object.assign(new Error(`디스크 공간이 부족해요(필요 ${Math.ceil(need / 1048576)}MB + 리스를 위한 여유 ${Math.ceil(await reserveBytes(root) / 1048576)}MB, 남음 ${Math.floor(free / 1048576)}MB)`), { status: 507 });
        if (job) { job.phase = name; job.total += Object.keys(files).length; job.done += sqliteFiles.size; }
        let settled = false;
        for (let pass = 0; pass < 3; pass++) {
          const todo = Object.entries(files).filter(([r, m]) => !sqliteFiles.has(r) && !same(got[r], m));
          if (!todo.length) { settled = true; break; }
          await pool(todo, PARALLEL, async ([r, m]) => {
            const dst = path.join(tmp, name, r);
            if (got[r]) await fsp.rm(dst, { force: true });
            let linked = false;
            if (same(m, before[r])) {
              try { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.link(path.join(root, prevId, name, r), dst); linked = true; } catch { linked = false; }
            }
            if (!linked) {
              try { await copyKeep(path.join(src, r), dst, m); } catch (e) { if (e.code === "ENOENT") return; throw e; }   // 그사이 지워진 파일
              // 복사하는 동안 바뀌었으면 다음 바퀴에서 다시
              const st = await fsp.stat(path.join(src, r)).catch(() => null);
              if (!st || st.size !== m[0] || Math.round(st.mtimeMs) !== m[1]) return;
              manifest.copied++;
            } else manifest.linked++;
            got[r] = m;
            if (job) { job.done++; job.bytes += m[0]; }
          });
          files = filterOut(await scan(src));   // 복사하는 동안 바뀐 것 확인
          for (const r of sqliteFiles) files[r] = got[r];
          for (const r of Object.keys(got)) if (!files[r]) { delete got[r]; await fsp.rm(path.join(tmp, name, r), { force: true }); }
        }
        if (!settled) settled = Object.entries(files).every(([r, m]) => sqliteFiles.has(r) || same(got[r], m));   // 마지막 바퀴 뒤에도 바뀐 게 없는지
        if (!settled) manifest.unstable = true;   // 백업하는 동안 리스가 계속 파일을 바꿨다 → 파일끼리 시점이 어긋날 수 있다
        manifest.sources[name] = got;
        manifest.count += Object.keys(got).length;
        manifest.bytes += Object.values(got).reduce((n, m) => n + m[0], 0);
      }
      manifest.ms = Date.now() - t0;
      await fsp.mkdir(tmp, { recursive: true });
      await fsp.writeFile(path.join(tmp, "manifest.json"), JSON.stringify(manifest));
      await fsp.rename(tmp, path.join(root, id));
    } catch (e) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); throw e; }
    // 오래된 것 정리(라벨 '복원 전'도 개수에 포함)
    const all = ids();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(path.join(root, old), { recursive: true, force: true });
    log(`백업 ${id}: 파일 ${manifest.count}개, 복사 ${manifest.copied} · 링크 ${manifest.linked}, ${manifest.ms}ms`);
    return { id, files: manifest.count, bytes: manifest.bytes, copied: manifest.copied, linked: manifest.linked, ms: manifest.ms };
  }

  // 복원 전 점검(리스를 멈추기 전에): 백업의 모든 파일이 실제로 있고 크기가 맞는지, 세이브가 비어 있지 않은지 본다.
  // 하나라도 어긋나면 복원을 시작하지 않는다(시작한 뒤에 실패하면 세이브가 반쯤 바뀐 채로 남는다).
  async function verify(id) {
    if (!ID_RE.test(String(id))) throw Object.assign(new Error("백업 이름이 맞지 않아요"), { status: 400 });
    const m = readManifest(id);
    if (!m) throw Object.assign(new Error("없는 백업이에요"), { status: 404 });
    if (!Object.keys(m.sources?.save ?? {}).length) throw Object.assign(new Error("이 백업에는 세이브 파일이 하나도 없어서 복원하지 않아요(복원하면 세이브가 모두 지워져요)"), { status: 422 });
    const bad = [];
    for (const [name] of sources()) {
      const want = m.sources?.[name] ?? {};
      const have = await scan(path.join(root, id, name));
      for (const [r, mm] of Object.entries(want)) if (!have[r] || have[r][0] !== mm[0]) bad.push(`${name}/${r}`);
    }
    if (bad.length) throw Object.assign(new Error(`백업 파일이 빠졌거나 달라서 복원하지 않아요(${bad.length}개: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? " …" : ""})`), { status: 422 });
    return { ok: true, files: m.count };
  }

  // 복원: 리스와 Cellar 서버가 멈춘 상태에서 불러야 한다(실행기가 처리). 다른 파일만 바꾸고 없는 파일은 지운다.
  async function restore(id) {
    if (!ID_RE.test(String(id))) throw Object.assign(new Error("백업 이름이 맞지 않아요"), { status: 400 });
    const m = readManifest(id);
    if (!m) throw Object.assign(new Error("없는 백업이에요"), { status: 404 });
    const t0 = Date.now();
    let replaced = 0, removed = 0;
    for (const [name, dir] of sources()) {
      const want = m.sources?.[name] ?? {};
      const have = await scan(dir);
      // 먼저 백업의 파일을 채우고, 지우는 건 맨 마지막에 한다(중간에 실패해도 파일이 모자란 상태가 되지 않게)
      await pool(Object.entries(want).filter(([r, mm]) => !same(have[r], mm)), PARALLEL, async ([r, mm]) => {
        const dst = path.join(dir, r), tmpf = dst + ".dusk-restore";
        await copyKeep(path.join(root, id, name, r), tmpf, mm);
        await fsp.rename(tmpf, dst);
        replaced++;
      });
      await pool(Object.keys(have).filter((r) => !want[r]), PARALLEL, async (r) => { await fsp.rm(path.join(dir, r), { force: true }); removed++; });
      await removeEmptyDirs(dir);
    }
    log(`복원 ${id}: 바꿈 ${replaced} · 지움 ${removed}, ${Date.now() - t0}ms`);
    return { id, replaced, removed, ms: Date.now() - t0 };
  }

  async function removeEmptyDirs(dir, top = true) {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), false);
    if (!top) { try { await fsp.rmdir(dir); } catch { /* 비어 있지 않음 */ } }
  }

  async function remove(id) {
    if (!ID_RE.test(String(id)) || !fs.existsSync(path.join(root, id))) throw Object.assign(new Error("없는 백업이에요"), { status: 404 });
    await fsp.rm(path.join(root, id), { recursive: true, force: true });
    return { ok: true, id };
  }

  // 오래 걸리는 백업은 작업으로 돌리고 상태를 물어보게 한다(한 번에 하나)
  function startCreate(opts) {
    if (job && !job.finishedAt) throw Object.assign(new Error("이미 백업 중이에요"), { status: 409 });
    job = { kind: "backup", phase: "scan", done: 0, total: 0, bytes: 0, startedAt: Date.now(), finishedAt: 0, error: "", result: null };
    const j = job;
    create(opts).then((r) => { j.result = r; }, (e) => { j.error = String(e?.message ?? e); }).finally(() => { j.finishedAt = Date.now(); j.phase = "done"; });
    return j;
  }

  return { list, create, startCreate, restore, verify, remove, status: () => job, has: (id) => !!readManifest(id), root };
}

module.exports = { createBackups, scan, ID_RE };
