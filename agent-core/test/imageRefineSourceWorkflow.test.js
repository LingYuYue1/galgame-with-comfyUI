/**
 * F-35 回归守卫：`loadSourceWorkflow` 的 resolvedMode 必须留在「模式值空间」。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 自定义工作流分支里：`resolvedMode = resolveCustomWorkflowPath(sourceMode) || fallbackModeForScene(scene)`
 * —— `resolveCustomWorkflowPath` 返回的是**绝对路径**（文件存在时），于是 resolvedMode
 * 混入了不属于模式值空间的值；随后 `pathForModeValue(resolvedMode)` **再解析一次**，
 * 绝对路径因含路径分隔符被判非法 → **静默回落到 turbo 工作流**（＝放大细化「继承原图参数」
 * 时拿错模板，全程无报错）。下游 `srcLabel` 也按「文件名」预期消费 resolvedMode
 * （与 PRO_WORKFLOW / ACTIVE_WORKFLOW 两常量并列）。
 *
 * ── 修法 ────────────────────────────────────────────────────
 * 对齐上游写法（三元判断、**保留原值**）：
 *   `resolveCustomWorkflowPath(sourceMode) ? sourceMode : fallbackModeForScene(scene)`
 *
 * 本文件钉住三条口径：①存在的自定义文件名 → resolvedMode 原样返回（不是绝对路径）；
 * ②加载的源模板确实是**该自定义工作流**（不是回落后的 turbo 模板）；
 * ③不存在文件名 / 显式 turbo·base / customWorkflow 三个既有分支不回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = ':memory:'

const { loadSourceWorkflow } = await import('../src/services/imageRefine.js')
const { apiToGui } = await import('../src/services/comfyClient.js')
const { PRO_WORKFLOW, ACTIVE_WORKFLOW } = await import('../src/services/workflowTemplates.js')
const { config } = await import('../src/config.js')

const WORKFLOW_DIR = fileURLToPath(new URL('../../workflow', import.meta.url))

/** 直接读某工作流文件的 GUI 形态（与 loadSourceWorkflow 的转换同路径，作对照 oracle） */
function guiOf(filename) {
  return apiToGui(JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, filename), 'utf8')))
}

test('F-35 ①：存在的自定义文件名 → resolvedMode 原样保留（不得混入绝对路径）', () => {
  const r = loadSourceWorkflow({ sourceMode: PRO_WORKFLOW })
  assert.equal(
    r.resolvedMode, PRO_WORKFLOW,
    `resolvedMode 应保持「文件名」（模式值空间），实际是：${r.resolvedMode}`,
  )
})

test('F-35 ②：源模板加载的是该自定义工作流（而非二次解析后回落的 turbo）', () => {
  const r = loadSourceWorkflow({ sourceMode: PRO_WORKFLOW })
  assert.ok(r.wf, 'wf 应加载成功')
  assert.deepEqual(r.wf, guiOf(PRO_WORKFLOW), '源的模板内容应与该自定义工作流一致')
  assert.notDeepEqual(r.wf, guiOf(ACTIVE_WORKFLOW), '（对照）不得是 turbo 的模板——那就是参数继承错源')
})

test('F-35 ③：不存在的文件名 → 走场景兜底（模式值空间），不回归', () => {
  const saved = config.workflow?.mode
  try {
    if (config.workflow) config.workflow.mode = 'turbo'   // 固定环境，免依赖用户配置
    const r = loadSourceWorkflow({ sourceMode: '__no_such_workflow__.json' })
    assert.equal(r.resolvedMode, 'turbo')
  } finally {
    if (config.workflow) config.workflow.mode = saved
  }
})

test('F-35 ④：显式 turbo/base 模式原样返回，不回归', () => {
  assert.equal(loadSourceWorkflow({ sourceMode: 'turbo' }).resolvedMode, 'turbo')
  assert.equal(loadSourceWorkflow({ sourceMode: 'base' }).resolvedMode, 'base')
})

test('F-35 ⑤：customWorkflow 参数（存在）优先加载，不回归', () => {
  const r = loadSourceWorkflow({ customWorkflow: PRO_WORKFLOW })
  assert.equal(r.resolvedMode, null, 'customWorkflow 分支不产生 resolvedMode')
  assert.deepEqual(r.wf, guiOf(PRO_WORKFLOW))
})
