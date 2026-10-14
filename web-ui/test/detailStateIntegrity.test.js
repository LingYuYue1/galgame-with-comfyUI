import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ★ F-21 回归守卫 —— 「假状态」与「重构遗留死代码」。
 *
 * ── 为什么要有这条测试 ────────────────────────────────────────
 * 本项目有过一类反复出现的缺陷：**大重构后，写方被删、读方留下**。
 *
 *  · 立绘生成从「本地 ref 记账（standingGenCharId）+ 任务表」改为**只用任务表**后，
 *    那两个 ref 的赋值随旧函数一起被删了，但 `standingBusy` / `standingBusyForChar`
 *    仍在读它们 → 表达式里挂着两个**永远为 null** 的项（恒假）。
 *  · 外观特化标签从「内嵌面板 + 已选 chip 行」改为**独立弹窗**后，
 *    parent 侧的 `traitCatalogLoading` 再也没人赋值 → 那枚按钮的 `:loading`
 *    **永远不转圈**（假 loading，用户看到"点了没反应"却不知在加载）。
 *
 * 这类缺陷的共同点：**编译不报错、构建能通过、单元测试也不覆盖**，只有人真去
 * 打开页面盯着才发现。所以必须在**静态层面**钉住，避免后续重构再次引入。
 *
 * 两条守卫：
 *   ① 通用 —— 模板里 `:loading` / `:disabled` / `:busy` 绑定的**可变状态**（ref/let），
 *      必须在脚本里存在**写入点**；否则它就是"永不改变"的假状态。
 *   ② 专项 —— F-21 清掉的那批遗留符号**不得回加**（回加须连同写入点/调用点一起加，
 *      并同步更新本测试）。
 *
 * 允许显式豁免：在绑定的同一行写 `/* busy-ok *​/`。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEBUI = path.resolve(HERE, '..')
const SRC = path.join(WEBUI, 'src')
const DETAIL = path.join(SRC, 'components', 'CharacterDetailModal.vue')

/** 会被当作「加载/禁用态」绑定的属性名 */
const BUSY_ATTRS = ['loading', 'disabled', 'busy']

function walkVue(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules') walkVue(p, out); continue }
    if (f.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 从一个 .vue 源码里提取所有 `:attr="裸标识符"` 的名字（拼接表达式如 `a && b` 不在此列） */
function bareBoundNames(src) {
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>/)
  if (!tplMatch) return null
  const tpl = tplMatch[1]
  const names = new Set()
  for (const attr of BUSY_ATTRS) {
    const re = new RegExp(':' + attr + '="([A-Za-z_$][\\w$]*)"', 'g')
    for (const m of tpl.matchAll(re)) names.add(m[1])
  }
  return names
}

/**
 * 扫描一个源码根目录，找「模板绑定了 loading/disabled/busy，但该可变状态从无写入点」的假状态。
 * @returns {{scanned:number, violations:{file:string,name:string}[]}}
 */
function scanFakeBusyStates(rootDir) {
  const violations = []
  let scanned = 0
  for (const file of walkVue(rootDir)) {
    const src = fs.readFileSync(file, 'utf8')
    const names = bareBoundNames(src)
    if (!names) continue
    scanned++
    for (const n of names) {
      // 只关心"可变的本地状态"：ref / shallowRef / reactive / let
      const declRe = new RegExp(
        '(?:const|let|var)\\s+' + n + '\\s*=\\s*(?:ref|shallowRef|reactive)\\s*\\(|let\\s+' + n + '\\b'
      )
      if (!declRe.test(src)) continue // 不是本地可变状态（props / computed / import）→ 不管
      // 写入点：`n = ` / `n.value = ` / `n.value += ` …（排除声明那一行）
      const writeRe = new RegExp(
        '^(?!\\s*(?:const|let|var)\\s+' + n + '\\b).*\\b' + n + '(?:\\.value)?\\s*(?:=[^=]|[+\\-*/]=|\\+\\+|--)',
        'm'
      )
      if (!writeRe.test(src)) violations.push({ file: path.relative(rootDir, file), name: n })
    }
  }
  return { scanned, violations }
}

test('★ 模板绑定的 loading/disabled/busy 必须有写入点（拦住"永不改变"的假状态）', (t) => {
  const { scanned, violations } = scanFakeBusyStates(SRC)
  assert.ok(scanned >= 50, `应扫到大量 .vue 源文件，实际 ${scanned}（守卫可能空转）`)
  t.diagnostic(`已检查 ${scanned} 个 .vue 文件`)
  assert.deepEqual(
    violations,
    [],
    '这些状态被模板绑成 loading/disabled 却从无写入点（永远是假状态）：\n' +
      violations.map(v => `  ${v.file} → ${v.name}`).join('\n')
  )
})

test('守卫本身有效：构造一个"永不改变"的 loading ref 必须被查出来', () => {
  const dir = fs.mkdtempSync(path.join(WEBUI, '.tmp-busy-'))
  try {
    // 假状态：只读不写 → 应被查出
    const bad = path.join(dir, 'bad')
    fs.mkdirSync(bad)
    fs.writeFileSync(path.join(bad, 'Bad.vue'),
      '<template><btn :loading="flag" /></template>\n<script setup>\nconst flag = ref(false)\n</script>\n')
    const r1 = scanFakeBusyStates(bad)
    assert.deepEqual(r1.violations.map(v => v.name), ['flag'], '应查出一个假状态')

    // 有写入点 → 不应报
    const good = path.join(dir, 'good')
    fs.mkdirSync(good)
    fs.writeFileSync(path.join(good, 'Good.vue'),
      '<template><btn :loading="flag" /></template>\n<script setup>\nconst flag = ref(false)\nasync function go(){ flag.value = true }\n</script>\n')
    assert.deepEqual(scanFakeBusyStates(good).violations, [], '有写入点不应报')

    // computed 是派生值，不算假状态
    const comp = path.join(dir, 'comp')
    fs.mkdirSync(comp)
    fs.writeFileSync(path.join(comp, 'Comp.vue'),
      '<template><btn :loading="busy" /></template>\n<script setup>\nconst busy = computed(() => a && b)\n</script>\n')
    assert.deepEqual(scanFakeBusyStates(comp).violations, [], 'computed 不应被误报')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 去掉注释（块注释 + 行注释，行注释不吞 `http://`）——「不得回加」只查真正的代码/样式 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('★ F-21：CharacterDetailModal 的立绘记账 / 外观特化 遗留死代码已清（不得回加）', () => {
  const src = stripComments(fs.readFileSync(DETAIL, 'utf8'))

  // ① 立绘：本地 ref 记账已并入 imageEditTasks 任务表，旧 ref 与其派生 computed 不留
  for (const sym of ['standingGenCharId', 'standingRegenCharId', 'standingGenerating', 'standingReimageing']) {
    assert.ok(!src.includes(sym), `立绘旧记账符号不应残留：${sym}（已完成迁移到 imageEditTasks 任务表）`)
  }
  // ② 外观特化：假 loading + 随内嵌面板/chip 行一并移除的代码与样式，不留
  for (const sym of [
    'traitCatalogLoading',
    'workOutfitText',
    'removeTrait',
    'trait-picked', 'trait-chip', 'trait-empty', 'trait-panel', 'trait-sec',
    'trait-group', 'trait-tag',
    'scene-auto-lead', 'scene-edit-note',
  ]) {
    assert.ok(!src.includes(sym), `F-21 已清理的遗留符号不应回加：${sym}`)
  }

  // ③ 面板契约不破：忙碌态仍由"任务表 + 场景生成"驱动，且照旧暴露给立绘面板
  assert.match(
    src,
    /const standingBusy = computed\(\(\) =>[\s\S]{0,160}standingTaskRunning[\s\S]{0,120}sceneGenerating/,
    'standingBusy 仍应由 standingTaskRunning / sceneGenerating 驱动'
  )
  assert.match(
    src,
    /const standingBusyForChar = computed\(\(\) =>[\s\S]{0,160}standingTaskRunning[\s\S]{0,120}sceneGenerating/,
    'standingBusyForChar 仍应由 standingTaskRunning / sceneGenerating 驱动'
  )
  assert.match(src, /busy:\s*standingBusy\b/, '面板接口仍须暴露 busy')
  assert.match(src, /busyForChar:\s*standingBusyForChar\b/, '面板接口仍须暴露 busyForChar')
})
