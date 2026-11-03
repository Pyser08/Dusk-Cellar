"use strict";
// 리스 서버(RisuBard·PocketRisu·리스AI 공통) 로그인·세션 호출 도우미. plugins.cjs와 assets.cjs가 함께 쓴다.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });

function createRisuClient({ saveDir, risuUrl, fetchImpl = globalThis.fetch, altUrls = [] }) {
  // 설정한 주소로 연결이 안 되면(연결 거부 등) 같은 PC의 흔한 포트(PORT 환경변수·7777·6001)도 한 번씩 시도하고, 되는 주소를 기억한다
  let base = risuUrl;
  const candidates = () => [...new Set([base, risuUrl, ...altUrls])];
  const why = (e) => e.name === "AbortError" ? "응답이 없어요" : `${e.message}${e.cause?.code ? ` (${e.cause.code})` : e.cause?.message ? ` (${e.cause.message})` : ""}`;
  async function risu(method, p, { body, headers, timeout = 20000, raw, bin } = {}) {
    let lastErr;
    for (const url of candidates()) {
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetchImpl(url + p, { method, headers: { ...(bin || (raw instanceof Uint8Array) ? {} : { "content-type": "application/json" }), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: ctrl.signal });
        base = url;
        if (bin) return { status: res.status, json: null, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
        let json = null; try { json = await res.json(); } catch { /* JSON 아님 */ }
        return { status: res.status, json };
      } catch (e) {
        lastErr = { url, e };
        if (e.name === "AbortError") break;      // 응답이 느린 것이지 주소가 틀린 게 아니다
      } finally { clearTimeout(t); }
    }
    const tried = candidates().join(", ");
    throw fail(424, `리스 서버에 연결하지 못했어요(시도한 주소: ${tried}): ${why(lastErr.e)}. Cellar를 켤 때 리스의 포트를 --risu-port로 알려 주세요`);
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
