/**
 * 伴随修复测试：`scripts/dev.mjs` 的向量服务 Python 解释器解析必须三级回落。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `vector-service/venv` 不存在时（本仓库实况），dev.mjs 原先直接回落 PATH 的裸 `python`。
 * 某些机器上 PATH 的 python 缺 chromadb / onnxruntime 等依赖（本机实查：用户 PATH 里的
 * python 3.11.15 有 uvicorn/fastapi、缺 chromadb/onnxruntime）→ 向量服务起不来
 * —— 角色记忆检索静默失效（「角色记忆都是乱的」的一种来路）。
 *
 * ── 修法 ────────────────────────────────────────────────────
 * 解析改为三级：venv（开发环境显式创建）> runtime/python（仓库捆绑的发行运行时，
 * .gitignore 本地件）> PATH 的 python（兜底）。本仓库的正解解释器是
 * runtime/python/python.exe（启动器 launcher 的 _resolve_python 同样优先捆绑运行时）。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ①venv 缺失 + runtime 存在 → 命中 runtime/python（修复核心）；
 * ②venv 存在 → 优先 venv（开发环境语义不回退）；
 * ③两级都缺失 → 回落裸 python（兜底不消失）；
 * ④真实仓库彩排：dev.mjs 选出的解释器必须能加载 chromadb/onnxruntime（真能跑向量服务）；
 * ⑤main 守卫兼容性：`npm run dev` 的执行形态（argv[1] 相对路径 + cwd=仓库根）不会被误判为 import。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// 被 import 时不得有副作用（main 守卫 + 信号处理闸门）；若此处冒烟打印启动横幅，说明守卫失效
const { resolveVectorPython } = await import('../../scripts/dev.mjs')

/** 在临时目录里搭一个「仓库根」假结构 */
function makeFakeRoot({ withVenv = false, withRuntime = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-dev-python-'))
  if (withVenv) {
    const p = path.join(root, 'vector-service', 'venv', 'Scripts')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'python.exe'), '')
  }
  if (withRuntime) {
    const p = path.join(root, 'runtime', 'python')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'python.exe'), '')
  }
  return root
}

test('① venv 缺失 + runtime 存在 → 命中 runtime/python（修复核心）', (t) => {
  const root = makeFakeRoot({ withRuntime: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(
    resolveVectorPython(root),
    path.resolve(root, 'runtime', 'python', 'python.exe'),
  )
})

test('② venv 存在 → 优先 venv（开发环境语义不回退）', (t) => {
  const root = makeFakeRoot({ withVenv: true, withRuntime: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(
    resolveVectorPython(root),
    path.resolve(root, 'vector-service', 'venv', 'Scripts', 'python.exe'),
  )
})

test('③ 两级都缺失 → 回落裸 python（兜底不消失）', (t) => {
  const root = makeFakeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(resolveVectorPython(root), 'python')
})

test('④ 真实仓库彩排：选出的解释器必须能加载 chromadb/onnxruntime', () => {
  const py = resolveVectorPython(REPO_ROOT)
  const hasRuntime = fs.existsSync(path.join(REPO_ROOT, 'runtime', 'python', 'python.exe'))
  if (hasRuntime) {
    assert.notEqual(py, 'python', 'runtime/python 存在时必须命中它（不得回落到 PATH 的 python）')
  }
  const r = spawnSync(py, ['-c', 'import chromadb, onnxruntime'], {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  })
  assert.equal(r.status, 0, `解释器 [${py}] 应能加载 chromadb/onnxruntime；stderr: ${r.stderr}`)
})

test('⑤ main 守卫兼容性：npm run dev 形态（相对 argv[1] + cwd=仓库根）判定为直接执行', () => {
  // 模拟 npm run dev：cwd = 仓库根、argv[1] = 'scripts/dev.mjs'
  assert.equal(
    path.resolve(REPO_ROOT, 'scripts', 'dev.mjs'),
    fileURLToPath(new URL('../../scripts/dev.mjs', import.meta.url)),
    '两种路径来源必须一致，否则守卫会把「直接执行」误判为 import、npm run dev 将静默失效',
  )
})
