import io, os, re, shutil, sys, time, subprocess

SRC = r'<项目根>\SnowLuma\index.mjs'
BAK = r'<项目根>\backup-snowluma-redbag-' + time.strftime('%Y%m%d-%H%M%S')

src = open(SRC, encoding='utf-8').read()
orig_len = len(src)

if 'type: "redbag"' in src:
    print('!! 已经打过补丁了，退出')
    sys.exit(1)

def sub_once(text, anchor, repl, label):
    n = text.count(anchor)
    if n != 1:
        raise SystemExit('锚点不唯一 [%s]: 出现 %d 次\n%r' % (label, n, anchor[:120]))
    return text.replace(anchor, repl, 1)

# ---------- A) 注册 redbag 段编解码 ----------
A_ANCHOR = 'var ELEMENT_CODECS = {\n'
A_REPL = '''var ELEMENT_CODECS = {
\tredbag: {
\t\tasync toSegment(element) {
\t\t\treturn {
\t\t\t\ttype: "redbag",
\t\t\t\tdata: {
\t\t\t\t\tgreeting: String(element.greeting ?? ""),
\t\t\t\t\tsubtitle: String(element.subtitle ?? ""),
\t\t\t\t\tlabel: String(element.label ?? ""),
\t\t\t\t\trendered: String(element.rendered ?? ""),
\t\t\t\t\turl: String(element.url ?? ""),
\t\t\t\t\tbill_no: String(element.billNo ?? ""),
\t\t\t\t\tauth_key: String(element.authKey ?? ""),
\t\t\t\t\tred_type: String(element.redType ?? "")
\t\t\t\t}
\t\t\t};
\t\t}
\t},
'''
src = sub_once(src, A_ANCHOR, A_REPL, 'A: ELEMENT_CODECS')

# ---------- B) 红包解码工具 + 预扫描 ----------
B_ANCHOR = 'function convertElements(elems, isGroup) {'
B_REPL = '''// ===== QQ 红包（elem tag 24）解码 =====
// SnowLuma 原本没有 tag 24 的解码器，整块被丢弃，桥只能看到 QQ 的兜底文本
// 「[QQ红包]请使用新版手机QQ查收红包。」，拿不到红包上的留言。
// 这里把未知字段的原始字节（rawHex，由未知字段捕获补丁提供）解出来。
function __rpVarint(buf, i) {
\tlet value = 0;
\tlet shift = 0;
\twhile (i < buf.length) {
\t\tconst byte = buf[i++];
\t\tvalue += (byte & 127) * 2 ** shift;
\t\tif ((byte & 128) === 0) return [value, i];
\t\tshift += 7;
\t\tif (shift > 56) break;
\t}
\tthrow new Error("redbag varint overflow");
}
function __rpFields(buf) {
\tconst out = [];
\tlet i = 0;
\twhile (i < buf.length) {
\t\tconst [key, afterKey] = __rpVarint(buf, i);
\t\ti = afterKey;
\t\tconst fieldNumber = Math.floor(key / 8);
\t\tconst wireType = key & 7;
\t\tif (wireType === 0) {
\t\t\tconst [value, afterValue] = __rpVarint(buf, i);
\t\t\ti = afterValue;
\t\t\tout.push([fieldNumber, 0, value]);
\t\t} else if (wireType === 2) {
\t\t\tconst [len, afterLen] = __rpVarint(buf, i);
\t\t\ti = afterLen;
\t\t\tif (i + len > buf.length) throw new Error("redbag overrun");
\t\t\tout.push([fieldNumber, 2, buf.subarray(i, i + len)]);
\t\t\ti += len;
\t\t} else if (wireType === 5) {
\t\t\ti += 4;
\t\t} else if (wireType === 1) {
\t\t\ti += 8;
\t\t} else {
\t\t\tthrow new Error("redbag wiretype " + wireType);
\t\t}
\t}
\treturn out;
}
function __rpAt(fields, fieldNumber, wireType) {
\tconst hit = fields.find((entry) => entry[0] === fieldNumber && entry[1] === wireType);
\treturn hit ? hit[2] : void 0;
}
function __rpText(buf) {
\tif (!buf || buf.length === 0) return "";
\ttry {
\t\treturn new TextDecoder().decode(buf);
\t} catch {
\t\treturn "";
\t}
}
function decodeRedPacketElement(elem) {
\tconst metadata = protobuf_getUnknownFieldMetadata(elem);
\tconst field = metadata?.fields?.find((entry) => entry.fieldNumber === 24 && entry.wireType === 2 && entry.rawHex);
\tif (!field?.rawHex) return null;
\ttry {
\t\tconst raw = Buffer.from(field.rawHex, "hex");
\t\tconst [len, offset] = __rpVarint(raw, 0);
\t\tconst outer = __rpFields(raw.subarray(offset, offset + len));
\t\tconst wrapper = __rpAt(outer, 1, 2);
\t\tif (!wrapper) return null;
\t\tconst mid = __rpFields(wrapper);
\t\tconst detail = __rpAt(mid, 3, 2);
\t\tif (!detail) return null;
\t\tconst info = __rpFields(detail);
\t\treturn {
\t\t\tgreeting: __rpText(__rpAt(info, 3, 2)),
\t\t\tsubtitle: __rpText(__rpAt(info, 4, 2)),
\t\t\tlabel: __rpText(__rpAt(info, 5, 2)),
\t\t\trendered: __rpText(__rpAt(info, 8, 2)),
\t\t\turl: __rpText(__rpAt(info, 14, 2)),
\t\t\tbillNo: __rpText(__rpAt(mid, 9, 2)),
\t\t\tauthKey: __rpText(__rpAt(mid, 10, 2)),
\t\t\tredType: String(__rpAt(mid, 11, 0) ?? "")
\t\t};
\t} catch (error) {
\t\tunknownElementLog.debug("redbag decode failed: %s", error instanceof Error ? error.message : String(error));
\t\treturn null;
\t}
}
function decodeRedbagsOnce(elems) {
\tconst decoded = /* @__PURE__ */ new Map();
\tfor (const elem of elems) {
\t\tconst redbag = decodeRedPacketElement(elem);
\t\tif (redbag) decoded.set(elem, redbag);
\t}
\treturn decoded;
}
function convertElements(elems, isGroup) {'''
src = sub_once(src, B_ANCHOR, B_REPL, 'B: convertElements')

# ---------- C) 循环前预扫描 ----------
C_ANCHOR = '\tconst hasRichContent = [...decodedCards.values()]'
idx = src.find(C_ANCHOR)
if idx < 0:
    raise SystemExit('锚点 C 未找到')
line_end = src.find('\n', idx)
C_LINE = src[idx:line_end]
C_REPL = C_LINE + '\n\tconst decodedRedbags = decodeRedbagsOnce(elems);\n\t// 有一条真红包时，QQ 兜底的那句「[QQ红包]请使用新版手机QQ查收红包。」要丢掉，\n\t// 否则她会同时看到「真红包」和那句看不懂的兜底文案。\n\tconst hasRedbag = decodedRedbags.size > 0;'
src = sub_once(src, C_LINE, C_REPL, 'C: hasRichContent')

# ---------- D) 循环内产出 redbag 段 ----------
D_ANCHOR = '\t\tlogUnknownWireMetadata(elem, "elem");\n'
D_REPL = D_ANCHOR + '''\t\tconst decodedRedbag = decodedRedbags.get(elem);
\t\tif (decodedRedbag) {
\t\t\tunknownElementLog.debug("redbag decoded greeting=%j bill_no=%j", decodedRedbag.greeting, decodedRedbag.billNo);
\t\t\tresult.push({
\t\t\t\ttype: "redbag",
\t\t\t\tgreeting: decodedRedbag.greeting,
\t\t\t\tsubtitle: decodedRedbag.subtitle,
\t\t\t\tlabel: decodedRedbag.label,
\t\t\t\trendered: decodedRedbag.rendered,
\t\t\t\turl: decodedRedbag.url,
\t\t\t\tbillNo: decodedRedbag.billNo,
\t\t\t\tauthKey: decodedRedbag.authKey,
\t\t\t\tredType: decodedRedbag.redType
\t\t\t});
\t\t}
'''
src = sub_once(src, D_ANCHOR, D_REPL, 'D: logUnknownWireMetadata')

# ---------- E) 文字段抑制 ----------
E_ANCHOR = 'if (text && hasRichContent) continue;'
E_REPL = 'if (text && (hasRichContent || hasRedbag)) continue;'
src = sub_once(src, E_ANCHOR, E_REPL, 'E: text suppress')

os.makedirs(BAK, exist_ok=True)
shutil.copy2(SRC, os.path.join(BAK, 'index.mjs'))
open(SRC, 'w', encoding='utf-8', newline='').write(src)
print('已写入 %s' % SRC)
print('字节 %d -> %d (+%d)' % (orig_len, len(src), len(src) - orig_len))
print('备份 %s' % BAK)
