// 휴대용 리스(bin/node가 같이 들어 있는 폴더: 윈도우 exe·맥 app 배포본)용 실행 파일 만들기.
// 원래 실행 파일 이름 + "_cellar" 로 만들어요: RisuBard.exe → RisuBard_cellar.exe, RisuBard.app → RisuBard_cellar.app
// git·pm2·시스템 Node 없이 리스에 들어 있는 bin/node로 Dusk Cellar를 함께 켜요.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SUFFIX = "_cellar";
const ENTRY_REL = path.join("server", "node", "server.cjs");

// 리스 폴더 안의 번들 Node (없으면 null)
function bundledNode(root, platform = process.platform) {
  const p = path.join(root, "bin", platform === "win32" ? "node.exe" : "node");
  return fs.existsSync(p) ? p : null;
}

// 원래 실행 파일 찾기: root 안의 *.exe / *.app (이미 만든 *_cellar 는 제외)
function findLaunchers(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { /* 없음 */ }
  const own = (n) => n.toLowerCase().replace(/\.(exe|app|bat|sh|command)$/, "").endsWith(SUFFIX);
  const exe = ents.filter((e) => e.isFile() && /\.exe$/i.test(e.name) && !own(e.name)).map((e) => e.name);
  const app = ents.filter((e) => e.isDirectory() && /\.app$/i.test(e.name) && !own(e.name)).map((e) => e.name);
  const sh = ents.filter((e) => e.isFile() && /^start\.sh$/i.test(e.name)).map((e) => e.name);
  return { exe, app, sh };
}
const baseOf = (name) => name.replace(/\.(exe|app|sh|bat|command)$/i, "");

// 맥 .app 안의 실행 스크립트 (터미널을 열어 로그를 보여 주고 브라우저도 열어요)
function macScript(name) {
  return `#!/bin/bash
# ${name}: 리스 + Dusk Cellar 함께 실행 (Dusk Cellar가 만든 파일)
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="\${PORT:-7777}"
if [ ! -f "$ROOT/bin/node" ] || [ ! -f "$ROOT/Dusk-Cellar/cellar-start.cjs" ]; then
  osascript -e 'display dialog "이 앱은 리스 폴더 안에 있어야 하고, Dusk-Cellar 폴더가 같이 있어야 해요." buttons {"확인"} default button 1' >/dev/null 2>&1
  exit 1
fi
(sleep 3 && open "http://localhost:$PORT") &
osascript <<ENDSCRIPT
tell application "Terminal"
  activate
  do script "cd '$ROOT' && PORT=$PORT exec ./bin/node Dusk-Cellar/cellar-start.cjs --risu server/node/server.cjs --data-dir Dusk-Cellar/dusk-data"
end tell
ENDSCRIPT
`;
}
function plist(name, version = "1.0") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>com.dusk.cellar.${name.replace(/[^A-Za-z0-9]/g, "")}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`;
}
function batScript(name) {
  return `@echo off
chcp 65001 >nul
title ${name}
cd /d "%~dp0"
if not defined PORT set PORT=7777
if not exist "bin\\node.exe" (echo [실패] bin\\node.exe 가 없어요. 리스 폴더 안에 두세요. & pause & exit /b 1)
if not exist "Dusk-Cellar\\cellar-start.cjs" (echo [실패] Dusk-Cellar 폴더가 없어요. & pause & exit /b 1)
start "" "http://localhost:%PORT%"
"bin\\node.exe" "Dusk-Cellar\\cellar-start.cjs" --risu "server\\node\\server.cjs" --data-dir "Dusk-Cellar\\dusk-data"
echo.
pause
`;
}
function shScript(name) {
  return `#!/bin/bash
# ${name}: 리스 + Dusk Cellar 함께 실행 (Dusk Cellar가 만든 파일)
cd "$(dirname "$0")" || exit 1
export PORT="\${PORT:-7777}"
NODE=./bin/node; [ -x "$NODE" ] || NODE=node
(sleep 3; (xdg-open "http://localhost:$PORT" || open "http://localhost:$PORT") >/dev/null 2>&1) &
exec "$NODE" Dusk-Cellar/cellar-start.cjs --risu server/node/server.cjs --data-dir Dusk-Cellar/dusk-data
`;
}

// 만들 것 계획: [{kind:"file"|"copy"|"dir", path, content|from, mode}] — 부수효과 없음
function plan({ root, platform, found, exeTemplate, icnsFor = () => null }) {
  const ops = [];
  if (platform === "win32") {
    const bases = found.exe.length ? found.exe.map(baseOf) : ["Risu"];
    for (const b of bases) {
      const name = b + SUFFIX;
      if (exeTemplate) ops.push({ kind: "copy", path: path.join(root, name + ".exe"), from: exeTemplate });
      else ops.push({ kind: "file", path: path.join(root, name + ".bat"), content: batScript(name) });
    }
  } else if (platform === "darwin") {
    const bases = found.app.length ? found.app.map(baseOf) : ["Risu"];
    for (const b of bases) {
      const name = b + SUFFIX, app = path.join(root, name + ".app");
      ops.push({ kind: "file", path: path.join(app, "Contents", "Info.plist"), content: plist(name) });
      ops.push({ kind: "file", path: path.join(app, "Contents", "MacOS", name), content: macScript(name), mode: 0o755 });
      const icns = icnsFor(b);
      if (icns) ops.push({ kind: "copy", path: path.join(app, "Contents", "Resources", "AppIcon.icns"), from: icns });
    }
  } else {
    ops.push({ kind: "file", path: path.join(root, "start" + SUFFIX + ".sh"), content: shScript("start" + SUFFIX), mode: 0o755 });
  }
  return ops;
}
function apply(ops) {
  for (const o of ops) {
    fs.mkdirSync(path.dirname(o.path), { recursive: true });
    if (o.kind === "copy") fs.copyFileSync(o.from, o.path);
    else fs.writeFileSync(o.path, o.content);
    if (o.mode) fs.chmodSync(o.path, o.mode);
  }
  return ops.map((o) => o.path);
}

module.exports = { SUFFIX, bundledNode, findLaunchers, baseOf, plan, apply, macScript, batScript, shScript, plist };
