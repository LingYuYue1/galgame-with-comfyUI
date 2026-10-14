/**
 * F-44 回归测试：`loadFeatureMigrations` 的 docstring 必须与实现/调用方**一致**。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `migrations/index.js` 的 docstring 原称：
 *   「**可重复调用**（幂等：已登记的 id 会**重建 registry 前先清空**）。供 **db/index.js** …调用」
 * 两处均与事实不符：
 *   · 实现**没有任何清空动作**——同进程内第二次调用会因 registry 的「迁移 id 重复」
 *     校验**直接抛错**（该校验是 registry 的**有意设计**：防清单复制粘贴改漏；
 *     且 `__resetRegistryForTest` 明言「生产路径永远不清」）；
 *   · 真实调用方是 **app.js**（启动时调用一次），不是 db/index.js。
 *
 * ── 修复选择（三层考古后）────────────────────────────────────
 * 改注释**如实描述**（而非实现清空重建）：registry 的防重复校验是有意安全网，
 * 「可重复调用」无真实需求（唯一生产调用点 app.js 一次），加清空反而弱化保护。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 注释如实：含真实调用方 app.js；不再声称「可重复调用 / 清空重建 / 供 db/index.js」；
 * ② 行为钉住：重复调用确实抛「迁移 id 重复」——未来若有人「顺手实现清空」改变语义，
 *    必须先改这条测试与注释（强制审视）。
 *
 * ⚠ 本文件会真实调用 loadFeatureMigrations 两次（第二次故意抛错）——独立进程内运行，
 *   不影响其它测试文件；registry 状态被刻意使用后不再复位（本进程到此为止）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { __resetRegistryForTest } from '../src/db/migrationRegistry.js'

const SRC = fileURLToPath(new URL('../src/db/migrations/index.js', import.meta.url))
const raw = fs.readFileSync(SRC, 'utf8')

test('守卫（行为钉住）：重复调用 loadFeatureMigrations 必须抛「迁移 id 重复」', async () => {
  __resetRegistryForTest()
  const { loadFeatureMigrations } = await import('../src/db/migrations/index.js')
  const first = await loadFeatureMigrations()
  assert.ok(first.loaded.length > 0, '首次调用应正常登记全部磁盘迁移')
  await assert.rejects(
    () => loadFeatureMigrations(),
    /迁移 id 重复/,
    '第二次调用必须抛 id 重复（registry 有意设计；若未来实现清空重建，须同步改注释与本测试）',
  )
})

test('主断言①：docstring 的调用方如实（app.js，不是 db/index.js）', () => {
  assert.match(raw, /app\.js/, 'docstring 应写明真实调用方 app.js（F-44 修复）')
  assert.doesNotMatch(raw, /供 db\/index\.js/, '不得再声称「供 db/index.js 调用」（实际调用在 app.js）')
})

test('主断言②：不得再声称「可重复调用 / 重建 registry 前先清空」', () => {
  assert.doesNotMatch(raw, /可重复调用/, '不得声称「可重复调用」——重复调用会抛 id 重复错')
  assert.doesNotMatch(raw, /重建 registry 前先清空/, '不得声称「重建前清空」——实现没有清空动作')
})
