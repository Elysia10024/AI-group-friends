// SnowLuma 补丁自检 —— 升级/重装 SnowLuma 会把 index.mjs 整个换掉，补丁随之消失。
//
// 为什么必须**大声失败**：补丁丢了的症状是「她看不到红包上的留言」这种几乎察觉不到的降级 ——
// 消息照样收得到，只是红包被当成手打的假红包去嘲讽。这种回归靠群里观察极难发现。
//
// 用法：
//   node patches/snowluma/check.mjs            # 自检（补丁缺失时退出码 1）
//   SNOWLUMA_DIR=/path/to/SnowLuma node ...    # 指定别的 SnowLuma 目录（测试用）
//
// 也可以被 import：`snowlumaStatus()` 只返回结果、不打印不退出，给 doctor 复用标志串定义。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 打补丁时记录的 SnowLuma 版本；升级后如果版本变了会额外告警。 */
export const PATCHED_VERSION = '1.14.17';

export const DEFAULT_SNOWLUMA_DIR = '<项目根>/SnowLuma';

/** 每个补丁至少要出现的标志串 —— 少一个就说明补丁被覆盖了。 */
export const CHECKS = [
  {
    name: 'rawHex 捕获（未知字段保留原始字节）',
    marker: 'rawHex: _unknownByteLength >=',
    min: 100,
    script: 'rawhex-capture.mjs',
    why: '红包元素（elem tag 24）只有 ≥150 字节的未知字段原始字节才解得出来'
  },
  {
    name: 'RAWHEX 日志行',
    marker: 'wire element RAWHEX',
    min: 1,
    script: 'rawhex-capture.mjs',
    why: '抓红包原始数据靠它'
  },
  {
    name: 'redbag 段编解码',
    marker: 'type: "redbag"',
    min: 1,
    script: 'redbag-decode.py',
    why: '桥靠 redbag 段区分「真红包 vs 手打的假红包」'
  },
  {
    name: '红包元素解码函数',
    marker: 'function decodeRedPacketElement',
    min: 1,
    script: 'redbag-decode.py',
    why: '解出红包上的留言（默认「恭喜发财」不给反应，自定义留言要接）'
  },
  {
    name: '红包预扫描',
    marker: 'function decodeRedbagsOnce',
    min: 1,
    script: 'redbag-decode.py',
    why: '有红包时丢掉 QQ 的兜底文案「请使用新版手机QQ查收红包。」'
  }
];

/**
 * 纯查询：读 index.mjs 数标志串。不打印、不退出、不抛异常（除读取失败）。
 * @returns {{dir:string,index:string,missingFile?:true,src?:string,version?:string,results?:Array,missing?:number}}
 */
export function snowlumaStatus(dir = DEFAULT_SNOWLUMA_DIR) {
  const index = path.join(dir, 'index.mjs');
  if (!fs.existsSync(index)) return { dir, index, missingFile: true };

  const src = fs.readFileSync(index, 'utf8');

  let version = '(未知)';
  try {
    // 去掉 BOM：Windows 上不少工具写 JSON 会带 UTF-8 BOM，JSON.parse 会直接抛
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
    version = JSON.parse(raw).version ?? '(未知)';
  } catch { /* 版本读不到不影响补丁自检 */ }

  const results = CHECKS.map((c) => {
    const count = src.split(c.marker).length - 1;
    return { ...c, count, ok: count >= c.min };
  });

  return { dir, index, src, version, results, missing: results.filter((r) => !r.ok).length };
}

function fail(lines) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  ❌ SnowLuma 补丁缺失 —— 红包功能已失效，需要重新打补丁      ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  console.error('  重新打补丁：');
  console.error('    node patches/snowluma/rawhex-capture.mjs    # 先打这个');
  console.error('    python patches/snowluma/redbag-decode.py    # 再打这个');
  console.error('    然后重启 SnowLuma（见 patches/snowluma/README.md）');
  console.error('');
  process.exit(1);
}

function main() {
  const dir = process.env.SNOWLUMA_DIR || DEFAULT_SNOWLUMA_DIR;
  const st = snowlumaStatus(dir);

  if (st.missingFile) {
    fail([`找不到 SnowLuma 的 index.mjs：${st.index}`, '用 SNOWLUMA_DIR 指定正确目录。']);
  }

  console.log('SnowLuma 补丁自检');
  console.log('  目录  : ' + dir);
  console.log('  版本  : ' + st.version + (st.version === PATCHED_VERSION ? '  （与打补丁时一致）' : `  ⚠ 打补丁时是 ${PATCHED_VERSION}`));
  console.log('  index : ' + (st.src.length / 1048576).toFixed(2) + ' MB');
  console.log('');
  for (const r of st.results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(30)} 命中 ${String(r.count).padStart(4)}（至少 ${r.min}）`);
  }
  console.log('');

  if (st.missing) {
    fail([
      `有 ${st.missing} 项标志串没找到 —— 说明 SnowLuma 被升级/重装过，补丁已丢失。`,
      '',
      ...st.results.filter((r) => !r.ok).map((r) => `缺失：${r.name}（${r.script}）—— ${r.why}`)
    ]);
  }

  if (st.version !== PATCHED_VERSION) {
    console.log(`  ⚠ SnowLuma 版本从 ${PATCHED_VERSION} 变成了 ${st.version}，但补丁标志串都在。`);
    console.log('    建议：确认红包功能仍正常，然后把 check.mjs 里的 PATCHED_VERSION 更新为 ' + st.version + '。');
    console.log('');
  }

  console.log('  ✅ 全部补丁在位');
}

// 只有被直接当脚本跑时才执行 CLI；被 import 时保持安静。
// 用 fileURLToPath 归一化比较，避免中文路径的百分号编码差异。
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main();
}
