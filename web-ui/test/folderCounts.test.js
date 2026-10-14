import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// F-20 回归（2026-10-13）：角色文件夹的「计数口径」与「删除后的本地归属同步」。
//
// 背景（同屏两个数字打架）：
//   分类栏 chip 报「活跃数」（= 点进去能看到几个），而移动角色弹窗与删除确认
//   报后端 /folders 的 f.count（= 该文件夹全部成员，**含归档**）。同一文件夹两处
//   数字不同，用户会以为其中一处坏了。
//
// 更严重的一条（顺手挖出来的连锁缺陷）：
//   后端删除文件夹是 `UPDATE characters SET folder_id = NULL WHERE folder_id = ?`
//   —— **不带 archived 条件，归档成员也会退回未分类**。但前端删除后只刷新了
//   folders 列表，`chat.characters` 里成员的 folder_id 未同步；而侧栏分组
//   `groupCharactersByFolder` 是「按 folders 分组 + 未分类按 folder_id 为 null 分组」，
//   于是这些角色既不属于任何文件夹组、也不属于未分类组 → **在侧栏里直接消失**，
//   未分类计数也少算，直到刷新页面才恢复。
//
// 本测试钉住五条语义：
//   ① 文件夹活跃计数排除归档（与视图实际渲染一致）
//   ② 未分类活跃计数同口径
//   ③ 删除后本地归属同步：成员（含归档）folder_id 清空，返回计数与后端动作一致
//   ③b 复现并堵住「角色无处可归 → 侧栏丢角色」的连锁后果
//   ④ 文件夹内归档成员数（供删除确认文案显式标注口径差）
//   ⑤（接线源扫描）TavernView 必须走本模块，且移动弹窗不得再裸用后端 f.count

const mod = await import('../src/utils/folderCounts.js')

// 与 store 一致的形状：{ id, folder_id, archived, display_name }
const C = (id, folder, archived, name = `角色${id}`) => ({ id, folder_id: folder, archived, display_name: name })

test('★ F-20①：文件夹活跃计数排除归档（与视图实际渲染一致）', () => {
  const chars = [C(1, 7, 0), C(2, 7, 0), C(3, 7, 1), C(4, 7, 1), C(5, 8, 0), C(6, null, 0)]

  assert.equal(mod.activeCountInFolder(chars, 7), 2, '文件夹 7：4 个成员里 2 个归档 → 活跃 2')
  assert.equal(mod.activeCountInFolder(chars, 8), 1)
  assert.equal(mod.activeCountInFolder(chars, 99), 0, '空文件夹计 0')
  assert.equal(mod.activeCountInFolder(chars, '7'), 2, '字符串 id 也要命中（接口/筛选取值形态不统一）')
  assert.equal(mod.activeCountInFolder(null, 7), 0, '空列表兜底，不抛错')
})

test('★ F-20②：未分类活跃计数同口径（排除归档）', () => {
  const chars = [C(1, 7, 0), C(6, null, 0), C(7, null, 1)]

  assert.equal(mod.activeUncategorizedCount(chars), 1, '未分类 2 个成员里 1 个归档 → 活跃 1')
  assert.equal(mod.activeUncategorizedCount([]), 0)
})

test('★ F-20③：删除文件夹后本地归属同步（含归档，与后端 SET folder_id=NULL 一致）', () => {
  const chars = [C(1, 7, 0), C(2, 7, 1), C(3, 8, 0), C(4, null, 0)]
  const n = mod.detachFolderFromCharacters(chars, 7)

  assert.equal(n, 2, '含归档成员一起退回未分类（后端删除文件夹不带 archived 条件）')
  assert.equal(chars[0].folder_id, null, '活跃成员退回未分类')
  assert.equal(chars[1].folder_id, null, '归档成员同样退回未分类')
  assert.equal(chars[2].folder_id, 8, '别的文件夹不受影响')
  assert.equal(chars[3].folder_id, null, '本来就未分类的不受影响')
  assert.equal(
    mod.activeUncategorizedCount(chars), 2,
    '清空后未分类活跃数才正确 = 1 原有活跃 + 1 退回的活跃成员（退回的那名归档成员不入活跃口径）',
  )
  assert.equal(mod.detachFolderFromCharacters(chars, 7), 0, '重复调用幂等（已无成员）')
})

test('★ F-20③b：删除后角色不会「无处可归」（复现并堵住侧栏丢角色）', () => {
  const chars = [C(1, 7, 0), C(2, 7, 1), C(3, 8, 0)]
  const foldersAfterDelete = [{ id: 8, name: '别的夹' }]   // 7 已被删除

  // 复刻侧栏 groupCharactersByFolder 的分组方式
  const render = (list) => {
    const inFolders = foldersAfterDelete.flatMap(f => list.filter(c => String(c.folder_id) === String(f.id)))
    const uncategorized = list.filter(c => !c.folder_id)
    return inFolders.length + uncategorized.length
  }

  assert.ok(
    render(chars) < chars.length,
    '修复前：folder_id 仍指向已删文件夹 → 既不属于任何文件夹组、也不属于未分类组（侧栏丢角色）',
  )

  mod.detachFolderFromCharacters(chars, 7)
  assert.equal(render(chars), chars.length, '修复后：所有角色都有归属，侧栏不丢角色')
})

test('★ F-20④：文件夹内归档成员数（供删除确认文案显式标注口径差）', () => {
  const chars = [C(1, 7, 0), C(2, 7, 1), C(3, 7, 1)]

  assert.equal(mod.archivedCountInFolder(chars, 7), 2)
  assert.equal(mod.archivedCountInFolder(chars, 8), 0, '空文件夹的归档数同样是 0')
})

test('★ F-20⑤（接线源扫描）：TavernView 走同一口径，移动弹窗不得裸用后端 f.count', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views', 'TavernView.vue'),
    'utf8',
  )

  assert.match(src, /from '\.\.\/utils\/folderCounts\.js'/, 'TavernView 必须引入统一口径模块')
  assert.match(src, /activeCountInFolder\(/, 'TavernView 的文件夹计数须走 activeCountInFolder')
  assert.match(src, /activeUncategorizedCount\(/, '未分类计数须走 activeUncategorizedCount')
  assert.match(src, /detachFolderFromCharacters\(/, '删除文件夹后须同步本地角色归属（否则侧栏丢角色）')
  assert.match(src, /archivedCountInFolder\(/, '删除确认文案须能算出归档成员数（显式标注口径差）')

  const pickIdx = src.indexOf('folder-pick-count')
  assert.ok(pickIdx > -1, '移动弹窗的计数元素应存在')
  const seg = src.slice(pickIdx, pickIdx + 160)
  assert.ok(!seg.includes('f.count'), '移动弹窗计数不得裸用后端 f.count（应与分类栏 chip 同为活跃口径）')
})
