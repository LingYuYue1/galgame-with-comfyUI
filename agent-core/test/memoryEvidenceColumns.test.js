/**
 * 记忆证据列兜底 —— F-11 回归测试（2026-10-12）。
 *
 * F-11 = 首轮筛查 P1：`memoryRepository` 的 INSERT 硬引用 memory_fragments 的
 * evidence 四列（evidence_text / evidence_count / evidence_msg_id / evidence_verified），
 * 但这四列只由**可插拔迁移 002** 添加，且 002 内部 try/catch 吞错 —— ALTER 失败时
 * registry 会把迁移误记为「已应用」：既不落 schema_migrations_failed、也永不重试
 * （表还不存在时的静默 return 同理）→ 四列永久缺失 → **每一次记忆写入都抛
 * no such column**，记忆系统整体静默瘫痪。
 *
 * 修复双管齐下：① initSchema 增加**幂等兜底**补列（不依赖 registry）；
 * ② 002 迁移不再吞错（失败交给 registry 留痕 + 重试）。
 *
 * ⚠ 本测试**刻意不加载/不运行 registry 迁移** —— 验证的就是「兜底是否独立生效」。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-memevidence-'));
process.env.DB_PATH = path.join(TMP_DIR, 'agent.db');
process.env.LINSHE_WORLD_PROJECTS_DIR = path.join(TMP_DIR, 'world-projects');

const { getDb, closeDb } = await import('../src/db/index.js');
const db = getDb();

test('★ F-11①：不跑 registry 迁移时，evidence 四列也由 initSchema 兜底存在', () => {
  const cols = new Set(db.prepare('PRAGMA table_info(memory_fragments)').all().map(c => c.name));
  for (const name of ['evidence_text', 'evidence_count', 'evidence_msg_id', 'evidence_verified']) {
    assert.ok(cols.has(name), `memory_fragments 应有 ${name} 列（缺失时记忆写入会全挂）`);
  }
});

test('★ F-11②：带 evidence 列的 INSERT 可正常写入（写入路径不依赖 registry 成功）', () => {
  const r = db.prepare(`
    INSERT INTO memory_fragments(
      conversation_id, fragment_type, content, memory_id, memory_type, judgment,
      evidence_text, evidence_count, evidence_msg_id, evidence_verified
    ) VALUES ('char_1', 'fact', '兜底测试', 'mem_test', 'fact', '判断', '原文摘录', 1, 42, 1)
  `).run();
  assert.equal(r.changes, 1, '带 evidence 列的最小写入应成功');
  const row = db.prepare(`SELECT evidence_text, evidence_verified FROM memory_fragments WHERE memory_id = 'mem_test'`).get();
  assert.equal(row.evidence_text, '原文摘录');
  assert.equal(row.evidence_verified, 1);
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
