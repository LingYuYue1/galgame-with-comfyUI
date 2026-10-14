import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// F-18 回归（2026-10-12）：「本分类全部恢复」按钮与批量开关的作用域口径。
//
// 背景：按钮显示条件 = `已归档数 > 0 && !全归档`，但计数若按「可见列表」统计：
//   普通分类视图只渲染未归档角色（归档角色只在「归档管理」出现）→
//   普通分类里「已归档数」结构性恒 0；「归档管理」里又必然全归档 →
//   按钮永不显示（死代码；分类全归档时开关也被禁用，形成无法一键恢复的死角）。
// 而后端 /archived-all 的动作范围是**作用域全体**（folder 类型含归档成员），
// 统计口径必须与动作范围对齐 —— 本测试钉住对齐后的四条语义：
//   ① 普通分类（部分归档）：已归档数含不可见成员 → 恢复入口显示；
//   ② 普通分类（全归档）：全归档判定为真（开关可点恢复）、恢复入口不显示；
//   ③ 归档管理视图：口径 = 可见归档批（搜索词生效），全归档判定为真；
//   ④ 「全部角色」+ 搜索词：动作按可见 ids 限定 → 恢复方向无命中（入口不显示）。
//   ⑤（接线源扫描）TavernView 必须走本模块的同一口径，避免两处公式漂移。

const { computeArchiveScope } = await import('../src/utils/archiveScope.js')

// 与 store 一致的形状：{ id, folder_id, archived, display_name }
const C = (id, folder, archived, name = `角色${id}`) => ({ id, folder_id: folder, archived, display_name: name })

test('★ F-18①：普通分类部分归档 → 已归档数含不可见成员，恢复入口显示', () => {
  const chars = [C(1, 7, 0), C(2, 7, 0), C(3, 7, 1), C(4, 7, 1), C(5, 8, 1), C(6, null, 1)]
  const visibleBatch = chars.filter(c => !c.archived && String(c.folder_id) === '7')
  const r = computeArchiveScope({ folderFilter: '7', search: '', characters: chars, visibleBatch })

  assert.equal(r.archivedCount, 2, '分类 7 的归档成员应计 2（修复前口径按可见列表统计 → 恒 0）')
  assert.equal(r.totalCount, 4, '分类 7 总成员数应 = 可见 2 + 归档 2')
  assert.equal(r.allArchived, false, '部分归档 ≠ 全归档')
  assert.equal(r.showRestore, true, '部分归档应显示「本分类全部恢复」入口')
  assert.deepEqual(r.archivedMembers.map(c => c.id).sort(), [3, 4], '恢复命中集 = 分类内归档成员')
})

test('★ F-18②：普通分类全归档 → 全归档判定为真（开关可一键恢复），入口不显示', () => {
  const chars = [C(1, 7, 1), C(2, 7, 1), C(9, 8, 0, '别的分类的活跃角色')]
  const visibleBatch = chars.filter(c => !c.archived && String(c.folder_id) === '7') // []
  const r = computeArchiveScope({ folderFilter: '7', search: '', characters: chars, visibleBatch })

  assert.equal(r.archivedCount, 2)
  assert.equal(r.totalCount, 2, '全归档时总成员数应仍为 2（修复前为 0 → 开关被禁用，无法一键恢复）')
  assert.equal(r.allArchived, true, '全归档应判定为真')
  assert.equal(r.showRestore, false, '全归档时开关即可恢复，不需直达按钮')
})

test('F-18③：归档管理视图 → 口径 = 可见归档批，全归档判定为真（开关=恢复全部）', () => {
  const chars = [C(1, 7, 1), C(2, 7, 0)]
  const visibleBatch = chars.filter(c => c.archived) // 归档管理里可见 = 归档集合
  const r = computeArchiveScope({ folderFilter: 'archived', search: '', characters: chars, visibleBatch })

  assert.equal(r.archivedCount, 1)
  assert.equal(r.totalCount, 1, '归档管理视图不叠加隐藏成员（防重复计数）')
  assert.equal(r.allArchived, true)
  assert.equal(r.showRestore, false)
})

test('F-18④：「全部角色」+ 搜索词 → 恢复方向无命中（动作按可见 ids 限定）', () => {
  const chars = [C(1, 7, 0, '三月七'), C(2, 7, 1, '青雀')]
  const visibleBatch = chars.filter(c => !c.archived && c.display_name.includes('三月')) // 搜索命中可见批
  const r = computeArchiveScope({ folderFilter: 'all', search: '三月', characters: chars, visibleBatch })

  assert.equal(r.archivedCount, 0, '带搜索词时动作按可见 ids 走，恢复无命中')
  assert.equal(r.showRestore, false)
})

test('F-18④b：「未分类」作用域同样按归档成员统计（含不可见）', () => {
  const chars = [C(1, null, 0), C(2, null, 1), C(3, 7, 1)]
  const visibleBatch = chars.filter(c => !c.archived && !c.folder_id)
  const r = computeArchiveScope({ folderFilter: 'uncategorized', search: '', characters: chars, visibleBatch })

  assert.equal(r.archivedCount, 1, '未分类的归档成员应计 1（分类 7 的不算）')
  assert.equal(r.totalCount, 2)
  assert.equal(r.showRestore, true)
})

test('F-18⑤（接线源扫描）：TavernView 走同一口径，恢复方向命中归档成员', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views', 'TavernView.vue'),
    'utf8',
  )
  assert.match(src, /computeArchiveScope\(/, 'TavernView 必须调用 computeArchiveScope')
  assert.match(
    src,
    /const scopeArchivedCount = computed\(\(\) => archiveScope\.value\.archivedCount\)/,
    'scopeArchivedCount 应接到统一口径（防两处公式漂移）',
  )
  assert.match(
    src,
    /const targets = next \? batchScopeCharacters\.value : archiveScope\.value\.archivedMembers/,
    'toggleAllArchived 恢复方向应以归档成员为命中集（本地同步才能点亮恢复的角色）',
  )
})
