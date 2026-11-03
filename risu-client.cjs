"use strict";
// 리스 서버(RisuBard·PocketRisu·리스AI 공통) 로그인·세션 호출 도우미. plugins.cjs와 assets.cjs가 함께 쓴다.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });

function createRisuClient({ saveDir, risuUrl, fetchImpl = globalThis.fetch }) {
  async function risu(method, p, { body, headers, timeout = 20000, raw } = {}) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetchImpl(risuUrl + p, { method, headers: { "content-type": "application/json", ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: ctrl.signal });
      let json = null; try { json = await res.json(); } catch { /* JSON 아님 */ }
      return { status: res.status, json };
    } catch (e) { throw fail(424, `리스 서버에 연결하지 못했어요(${risuUrl}): ${e.name === "AbortError" ? "응답이 없어요" : e.message}`); } finally { clearTimeout(t); }
  }
  async function connect() {
    let pw = ""; try { pw = fs.readFileSync(path.join(saveDir, "__password"), "utf8").trim(); } catch { /* 아래에서 */ }
    if (!pw) throw fail(424, "리스 암호 파일(__password)을 읽지 못했어요. 리스에 암호가 설정돼 있어야 해요");
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
    return { risu, headers: () => headers, renew: async () => { headers = await session(); } };
  }
  return { risu, connect, fail };
}
module.exports = { createRisuClient, fail };
