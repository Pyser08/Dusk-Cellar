const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../portable.cjs");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dusk-pt-")));

test("원래 exe·app을 찾고, 이미 만든 _cellar 는 제외", () => {
  const r = tmp();
  fs.writeFileSync(path.join(r, "RisuBard.exe"), "x");
  fs.writeFileSync(path.join(r, "RisuBard_cellar.exe"), "x");
  fs.mkdirSync(path.join(r, "RisuBard.app"));
  fs.mkdirSync(path.join(r, "RisuBard_cellar.app"));
  const f = P.findLaunchers(r);
  assert.deepEqual(f.exe, ["RisuBard.exe"]); assert.deepEqual(f.app, ["RisuBard.app"]);
});

test("윈도우: 템플릿 exe가 있으면 이름_cellar.exe 복사, 없으면 .bat", () => {
  const r = tmp();
  const found = { exe: ["RisuBard.exe"], app: [], sh: [] };
  let ops = P.plan({ root: r, platform: "win32", found, exeTemplate: "/t/l.exe" });
  assert.equal(path.basename(ops[0].path), "RisuBard_cellar.exe"); assert.equal(ops[0].kind, "copy");
  ops = P.plan({ root: r, platform: "win32", found, exeTemplate: null });
  assert.equal(path.basename(ops[0].path), "RisuBard_cellar.bat");
  assert.match(ops[0].content, /bin\\node\.exe/); assert.match(ops[0].content, /cellar-start\.cjs/);
  assert.ok(!/(^|[^\r])\n/.test(ops[0].content), "윈도우 .bat는 CRLF여야 해요(LF만 있으면 cmd가 한글 줄을 잘못 읽음)");
});

test("install.bat도 CRLF", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "install.bat"), "utf8");
  assert.ok(raw.includes("\r\n") && !/(^|[^\r])\n/.test(raw));
});

test("맥: .app 번들(Info.plist·실행 스크립트·아이콘 복사), 이름은 원본_cellar", () => {
  const r = tmp();
  const ops = P.plan({ root: r, platform: "darwin", found: { exe: [], app: ["RisuBard.app"], sh: [] }, icnsFor: () => "/i/AppIcon.icns" });
  const paths = ops.map((o) => path.relative(r, o.path));
  assert.deepEqual(paths, ["RisuBard_cellar.app/Contents/Info.plist", "RisuBard_cellar.app/Contents/MacOS/RisuBard_cellar", "RisuBard_cellar.app/Contents/Resources/AppIcon.icns"]);
  assert.match(ops[0].content, /<string>RisuBard_cellar<\/string>/);
  assert.equal(ops[1].mode, 0o755); assert.match(ops[1].content, /Dusk-Cellar\/cellar-start\.cjs/);
  P.apply(ops.slice(0, 2));
  assert.ok(fs.statSync(path.join(r, paths[1])).mode & 0o111);
});

test("원본 이름을 못 찾아도 기본 이름으로 만들고, 리눅스는 start_cellar.sh", () => {
  const r = tmp();
  assert.equal(path.basename(P.plan({ root: r, platform: "win32", found: { exe: [], app: [], sh: [] } })[0].path), "Risu_cellar.bat");
  const ops = P.plan({ root: r, platform: "linux", found: { exe: [], app: [], sh: ["start.sh"] } });
  assert.equal(path.basename(ops[0].path), "start_cellar.sh");
});

test("번들 Node 감지", () => {
  const r = tmp(); assert.equal(P.bundledNode(r, "linux"), null);
  fs.mkdirSync(path.join(r, "bin")); fs.writeFileSync(path.join(r, "bin", "node"), "");
  assert.equal(P.bundledNode(r, "linux"), path.join(r, "bin", "node"));
});

test("setup.cjs --portable: 가짜 휴대용 리스에서 파일 생성(--dry-run은 안 만듦)", () => {
  const { spawnSync } = require("node:child_process");
  const r = tmp();
  fs.mkdirSync(path.join(r, "server", "node"), { recursive: true }); fs.writeFileSync(path.join(r, "server", "node", "server.cjs"), "");
  fs.mkdirSync(path.join(r, "bin")); fs.writeFileSync(path.join(r, "bin", "node"), "");
  const run = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "setup.cjs"), "--risu", path.join(r, "server/node/server.cjs"), ...a], { encoding: "utf8" });
  const d = run("--dry-run"); assert.equal(d.status, 0, d.stderr + d.stdout);
  assert.deepEqual(fs.readdirSync(r).sort(), ["bin", "server"]);
  const x = run(); assert.equal(x.status, 0, x.stderr);
  const made = fs.readdirSync(r).filter((n) => /_cellar/.test(n));
  assert.equal(made.length, 1);
});
