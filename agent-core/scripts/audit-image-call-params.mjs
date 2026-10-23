/**
 * 生图调用参数体检器（2026-10-23，配合方案 §19「全链路体检」）
 *
 * 回答一个问题：**每一条生图链路，到底传了什么？**
 *   · 传了 `scene` 吗（决定全局 LoRA 白名单能不能命中）
 *   · 传了 `promptScene` 吗（只影响 RAG/提示词，**不影响 LoRA**）
 *   · 画师串取哪个配置项、尺寸是不是写死的
 *   · 有没有传 `anchors`（角色/用户外观锚点）
 *
 * 用法：node scripts/audit-image-call-params.mjs [--md] [--strict]
 *   --md      输出 Markdown 表格，便于贴进施工方案
 *   --strict  有任何清单外/缺失的 scene 就退出码 1（可挂 CI）
 *
 * 提取逻辑在 `scripts/lib/image-call-scan.mjs`，与 `test/loraSceneCoverage.test.js` 共用，
 * 避免脚本和测试各写一套正则、口径分叉。
 */
import path from 'path';
import { scanImageCalls, FIELDS } from './lib/image-call-scan.mjs';
import { isKnownScene, IMAGE_SCENE_KEYS } from '../src/services/imageScenes.js';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');
const rows = scanImageCalls(ROOT);

const md = process.argv.includes('--md');
const strict = process.argv.includes('--strict');
const brief = (v) => (v == null ? '—' : v.length > 46 ? v.slice(0, 46) + '…' : v);

if (md) {
  console.log('| 文件:行 | 调用 | scene | promptScene | artist | 尺寸 | anchors |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const size = r.width || r.height ? `${brief(r.width) || '?'}×${brief(r.height) || '?'}` : '—';
    console.log(`| \`${r.file}:${r.line}\` | ${r.call} | ${brief(r.scene)} | ${brief(r.promptScene)} | ${brief(r.artist)} | ${size} | ${brief(r.anchors)} |`);
  }
} else {
  for (const r of rows) {
    console.log(`\n── ${r.file}:${r.line}  ${r.call}`);
    for (const f of FIELDS) if (r[f] != null) console.log(`   ${f.padEnd(14)} ${brief(r[f])}`);
  }
}

console.log(`\n合计 ${rows.length} 处调用`);
console.log(`场景清单（${IMAGE_SCENE_KEYS.length} 项）：${IMAGE_SCENE_KEYS.join(' / ')}`);

// ── 问题清单 ──

const unknown = rows.filter(r => r.scene && !isKnownScene(r.scene.replace(/^['"]|['"]$/g, '')));
const noScene = rows.filter(r => r.scene == null);

console.log(`\n【A】scene 值不在清单里：${unknown.length} 处`);
for (const r of unknown) console.log(`   · ${r.file}:${r.line}  scene=${r.scene}`);

console.log(`\n【B】没传 scene（会绕过白名单，等于"永远生效"）：${noScene.length} 处`);
for (const r of noScene) console.log(`   · ${r.file}:${r.line}  ${r.call}  promptScene=${r.promptScene ?? '—'}`);

if (strict && (unknown.length || noScene.length)) {
  console.error('\n✗ strict 模式：存在未对齐的 scene，退出码 1');
  process.exit(1);
}
