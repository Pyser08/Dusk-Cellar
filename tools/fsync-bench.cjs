// 디스크 쓰기 방식 비교(서버에서 실행): node fsync-bench.cjs [폴더] [개수] [파일크기KB]
//  A) 리스바드 기본 방식: 파일 쓰기+fsync → 이름 바꾸기 → 폴더 fsync (에셋 하나마다)
//  B) 한꺼번에: 파일 쓰기(fsync 없음) → 이름 바꾸기 → 끝나고 sync 한 번
// 폴더는 세이브가 있는 디스크 안의 빈 임시 폴더를 쓰세요(끝나면 지워요). 읽기만 하고 세이브는 건드리지 않아요.
"use strict";
const fs = require("node:fs"), fsp = fs.promises, path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), { execFileSync } = require("node:child_process");
const base = path.resolve(process.argv[2] || path.join(os.tmpdir(), "dusk-fsync-bench"));
const N = Number(process.argv[3] || 1000), KB = Number(process.argv[4] || 200);
const data = crypto.randomBytes(KB * 1024);
const fsyncDir = (d) => { const fd = fs.openSync(d, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const name = (i) => crypto.createHash("sha256").update(String(i) + Math.random()).digest("hex");
async function A(dir) {
  for (let i = 0; i < N; i++) {
    const h = name(i), d = path.join(dir, h.slice(0, 2)); fs.mkdirSync(d, { recursive: true });
    const t = path.join(d, `.${h}.tmp`), fd = fs.openSync(t, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(t, path.join(d, h + ".bin")); fsyncDir(d);
  }
}
async function B(dir) {
  const dirs = new Set();
  for (let i = 0; i < N; i++) {
    const h = name(i), d = path.join(dir, h.slice(0, 2)); fs.mkdirSync(d, { recursive: true }); dirs.add(d);
    const t = path.join(d, `.${h}.tmp`); fs.writeFileSync(t, data); fs.renameSync(t, path.join(d, h + ".bin"));
  }
  try { execFileSync("sync"); } catch { for (const d of dirs) fsyncDir(d); }
}
(async () => {
  console.log(`폴더 ${base} · ${N}개 × ${KB}KB`);
  for (const [label, fn] of [["A 기본(에셋마다 fsync 2번)", A], ["B 한꺼번에(끝에 sync 한 번)", B]]) {
    const dir = path.join(base, label[0]); await fsp.rm(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const t0 = process.hrtime.bigint(); await fn(dir); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label}: ${(ms / 1000).toFixed(1)}초 · 개당 ${(ms / N).toFixed(2)}ms · 30만 개면 약 ${(ms / N * 3e5 / 3.6e6).toFixed(1)}시간`);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  await fsp.rm(base, { recursive: true, force: true });
})();
