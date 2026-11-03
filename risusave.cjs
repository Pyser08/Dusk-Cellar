"use strict";
// 리스의 database.bin에서 플러그인 목록만 읽고 바꾼다(RisuBard 밖의 PocketRisu·순정 리스AI용).
//   · 블록 형식("RISUSAVE\0"): 'plugins' 블록(JSON 문자열, gzip일 수 있음) 하나만 바꿔 끼운다. 캐릭터·채팅은 풀지 않고 바이트 그대로 둔다.
//   · 옛 형식(raw·compressed·stream): 전체를 풀어 plugins만 바꾸고 다시 묶는다. 이때만 호스트의 msgpackr·fflate가 필요하다(hostDir에서 찾는다).
const zlib = require("node:zlib");
const path = require("node:path");
const { createRequire } = require("node:module");
const { fail } = require("./risu-client.cjs");

const BLOCK_MAGIC = Buffer.from("RISUSAVE\0", "latin1");
const LEGACY_PREFIX = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0]);   // \0RISUSAVE\0 뒤에 7=raw, 8=compressed, 9=stream
const T_PLUGINS = 9, T_REMOTE = 6;

function formatOf(buf) {
  if (buf.length >= BLOCK_MAGIC.length && buf.subarray(0, BLOCK_MAGIC.length).equals(BLOCK_MAGIC)) return "blocks";
  if (buf.length > LEGACY_PREFIX.length && buf.subarray(0, LEGACY_PREFIX.length).equals(LEGACY_PREFIX)) return { 7: "raw", 8: "compressed", 9: "stream" }[buf[LEGACY_PREFIX.length]] ?? "unknown";
  return "unknown";
}

// 블록 목록: [type u8][compression u8][nameLen u8][name][len u32LE][data]
function scan(buf) {
  const blocks = []; let o = BLOCK_MAGIC.length;
  while (o < buf.length) {
    if (o + 3 > buf.length) throw fail(422, "database.bin의 블록 머리가 잘려 있어요");
    const type = buf[o], comp = buf[o + 1], nl = buf[o + 2], nameAt = o + 3, lenAt = nameAt + nl;
    if (lenAt + 4 > buf.length) throw fail(422, "database.bin의 블록 머리가 잘려 있어요");
    const len = buf.readUInt32LE(lenAt), dataAt = lenAt + 4;
    if (dataAt + len > buf.length) throw fail(422, "database.bin의 블록이 잘려 있어요");
    blocks.push({ type, comp, name: buf.toString("utf8", nameAt, lenAt), start: o, dataAt, end: dataAt + len });
    o = dataAt + len;
  }
  return blocks;
}

function createCodec({ hostDir, lib } = {}) {
  let libs = lib ?? null;
  const load = () => {
    if (libs) return libs;
    try {
      const req = createRequire(path.join(hostDir || process.cwd(), "x.js"));
      const { Packr, Unpackr } = req("msgpackr"), fflate = req("fflate");
      const packr = new Packr({ useRecords: false }), unpackr = new Unpackr({ int64AsType: "number", useRecords: false });
      libs = { pack: (o) => Buffer.from(packr.encode(o)), unpack: (b) => unpackr.decode(b), inflate: (b) => Buffer.from(fflate.decompressSync(b)), deflate: (b) => Buffer.from(fflate.compressSync(b)), gunzip: (b) => zlib.gunzipSync(b) };
    } catch (e) { throw fail(501, `이 세이브는 옛 형식이라 리스의 msgpackr·fflate가 필요한데 찾지 못했어요(${e.message.split("\n")[0]})`); }
    return libs;
  };

  // buf → { format, plugins, encode(plugins) → Buffer }
  function open(buf) {
    const format = formatOf(buf);
    if (format === "blocks") {
      const blocks = scan(buf), b = blocks.find((x) => x.name === "plugins");
      if (!b) throw fail(422, "이 세이브에는 plugins 블록이 없어요(플러그인을 한 번도 설치하지 않은 세이브일 수 있어요). 리스에서 플러그인을 하나 설치한 뒤 다시 해 주세요");
      if (b.type === T_REMOTE) throw fail(501, "plugins 블록이 원격 저장소에 있어서 고칠 수 없어요");
      if (b.type !== T_PLUGINS) throw fail(422, "plugins 블록의 종류가 예상과 달라요");
      let raw = buf.subarray(b.dataAt, b.end);
      if (b.comp === 1) { try { raw = zlib.gunzipSync(raw); } catch { throw fail(422, "plugins 블록을 풀지 못했어요"); } }
      let plugins; try { plugins = JSON.parse(raw.toString("utf8")); } catch { throw fail(422, "plugins 블록이 올바른 JSON이 아니에요"); }
      if (!Array.isArray(plugins)) throw fail(422, "plugins 블록이 배열이 아니에요");
      const encode = (next) => {
        let data = Buffer.from(JSON.stringify(next), "utf8");
        const comp = b.comp === 1 ? 1 : 0;
        if (comp) data = zlib.gzipSync(data);
        const head = Buffer.alloc(b.dataAt - 4 - b.start + 4);
        buf.copy(head, 0, b.start, b.dataAt - 4); head.writeUInt32LE(data.length, head.length - 4);
        return Buffer.concat([buf.subarray(0, b.start), head, data, buf.subarray(b.end)]);
      };
      return { format, plugins, encode };
    }
    if (format === "unknown") throw fail(422, "database.bin의 형식을 알아보지 못했어요");
    const L = load(), body = buf.subarray(LEGACY_PREFIX.length + 1);
    let db;
    try { db = L.unpack(format === "raw" ? body : format === "compressed" ? L.inflate(body) : L.gunzip(body)); } catch (e) { throw fail(422, `database.bin을 풀지 못했어요: ${e.message}`); }
    if (!db || typeof db !== "object" || !Array.isArray(db.plugins ?? [])) throw fail(422, "database.bin에 plugins가 없어요");
    const encode = (next) => {
      const packed = L.pack({ ...db, plugins: next });
      const flag = format === "raw" ? 7 : 8;
      return Buffer.concat([LEGACY_PREFIX, Buffer.from([flag]), flag === 7 ? packed : L.deflate(packed)]);
    };
    return { format, plugins: db.plugins ?? [], encode };
  }
  return { open };
}
module.exports = { createCodec, formatOf, scan, BLOCK_MAGIC, LEGACY_PREFIX };
