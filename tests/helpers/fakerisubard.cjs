// 시험 도우미: RisuBard 세이브 폴더 흉내 + 가짜 RisuBard 서버(로그인·세션·외부 변경 검토만)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dusk-plugins-")));

// RisuBard가 세이브 폴더에 두는 파일을 흉내 낸다(settings/app.json, 비밀이 섞이면 secrets/credentials.json)
const plugin = (name, extra = {}) => ({
  name, displayName: name, enabled: true, version: "3.0", versionOfPlugin: "1.0.0", updateURL: "",
  script: `//@name ${name}\n//@api 3.0\nconsole.log("${name} 1");\n`,
  arguments: {}, realArg: {}, customLink: [], argMeta: {}, ...extra,
});
function setup({ where = "settings", plugins, indent = 2, others = { theme: "dark", count: 3 } } = {}) {
  const saveDir = tmp(), dataDir = tmp();
  plugins = plugins ?? [plugin("dusk_atelier"), plugin("other")];
  fs.mkdirSync(path.join(saveDir, "settings"), { recursive: true });
  fs.mkdirSync(path.join(saveDir, "secrets"), { recursive: true });
  const put = (rel, obj) => {
    const text = JSON.stringify(obj, null, indent) + "\n";
    fs.writeFileSync(path.join(saveDir, rel), text);
    fs.writeFileSync(path.join(saveDir, rel + ".sha256"), sha(text) + "\n");
    return text;
  };
  const settingsText = put("settings/app.json", where === "settings" ? { schemaVersion: 1, ...others, plugins } : { schemaVersion: 1, ...others });
  const secretsText = put("secrets/credentials.json", where === "secrets" ? { schemaVersion: 1, openaiKey: "sk-xxx", plugins } : { schemaVersion: 1, openaiKey: "sk-xxx" });
  fs.writeFileSync(path.join(saveDir, "__password"), "pw\n");
  fs.mkdirSync(path.join(saveDir, "index"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "index", "sidebar.json"), "{}");
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(saveDir, rel), "utf8"));
  return { saveDir, dataDir, read, settingsText, secretsText, plugins };
}

// 가짜 RisuBard: 로그인·세션·외부 변경 검토(/api/external-changes[/resolve])만 흉내 낸다.
// 파일 지문 = 크기 + mtime(나노초) + 사이드카 내용(실제 RisuBard와 같다). 받아들인 상태와 다르면 '검토 대기'.
async function fakeRisubard(saveDir, opts = {}) {
  const FILES = ["settings/app.json", "secrets/credentials.json"];
  const calls = [];
  const fp = (rel) => {
    try { const p = path.join(saveDir, rel); const st = fs.statSync(p, { bigint: true }); let sc = ""; try { sc = fs.readFileSync(p + ".sha256", "utf8").trim(); } catch {} return `${st.size}:${st.mtimeNs}:${sc}`; } catch { return "missing"; }
  };
  let accepted = Object.fromEntries(FILES.map((f) => [f, fp(f)]));
  const changed = () => FILES.filter((f) => fp(f) !== accepted[f]);
  const revision = () => sha(changed().map(fp).join("|") || "none");
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch {}
      calls.push({ method: req.method, path: url.pathname, body, headers: req.headers });
      if (url.pathname === "/api/login") {
        if (opts.failLogin || String(body.password ?? "").trim() !== "pw") return json(res, 400, { error: "Password incorrect" });
        return json(res, 200, { status: "success", token: "TOKEN" });
      }
      if (req.headers["risu-auth"] !== "TOKEN") return json(res, 400, { error: "No auth header" });
      if (url.pathname === "/api/session" && req.method === "POST") return json(res, 200, { ok: true });
      if (url.pathname === "/api/external-changes" && req.method === "GET") {
        // extraPending: 우리가 쓴 뒤에만 다른 파일 변경이 함께 보이는 경우(그 사이 누가 고친 상황)
        const list = [...changed(), ...(changed().length ? opts.extraPending ?? [] : [])];
        return json(res, 200, { pending: list.length ? { revision: revision(), changes: list.map((p) => ({ kind: p.startsWith("secrets") ? "secrets" : "settings", id: p, path: p, status: "changed", fields: [] })), errors: opts.pendingErrors ?? [], hasDetails: true, reloadOnAccept: true } : null });
      }
      if (url.pathname === "/api/external-changes/resolve" && req.method === "POST") {
        if (!req.headers["x-session-id"]) return json(res, 423, { error: "Session deactivated" });
        if (opts.staleResolve) return json(res, 423, { error: "Session deactivated" });
        if (body.revision !== revision()) return json(res, 409, { code: "EXTERNAL_CHANGES_CHANGED", error: "The files changed again" });
        if (body.decision === "accept") { accepted = Object.fromEntries(FILES.map((f) => [f, fp(f)])); return json(res, 200, { decision: "accept", resolved: true, reload: true }); }
        return json(res, 400, { error: "decision must be accept or keep" });
      }
      json(res, 404, { error: "nope" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, pending: changed, close: () => new Promise((r) => server.close(r)), editExternally: (rel, text) => { fs.writeFileSync(path.join(saveDir, rel), text); } };
}

module.exports = { sha, tmp, plugin, setup, fakeRisubard };
