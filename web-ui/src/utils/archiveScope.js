/**
 * 批量归档 / 恢复的「作用域」口径（F-18）。
 *
 * ── 这个模块解决什么问题 ─────────────────────────────────────
 * 角色页的「一键让本分类不参与活动」开关与「本分类全部恢复」直达按钮，
 * 动作范围（后端 `/api/characters/archived-all` 的 scope）是**作用域全体**：
 *   · folder / uncategorized / all（无搜索词）→ 分类内全部角色（**含归档成员**）
 *   · all + 搜索词 / 归档管理视图 → 前端按可见 ids 精确限定（见 currentScope()）
 *
 * 但页面统计若按「可见列表」算——普通分类视图只渲染未归档角色（归档角色只在
 * 「归档管理」出现）——「已归档数」会结构性恒为 0：
 *   「本分类全部恢复」按钮永不显示（死代码）；分类全归档时开关也被禁用，
 *   形成无法一键恢复的死角。
 *
 * 本模块把统计口径**对齐动作范围**，供 TavernView 的开关/计数/按钮共用。
 */

/**
 * @param {object} p
 * @param {string} p.folderFilter  当前分类筛选：'all' | 'archived' | 'uncategorized' | 文件夹 id（字符串）
 * @param {string} p.search        当前搜索词
 * @param {Array}  p.characters    全量角色（{ id, folder_id, archived, display_name }，与 store 同形）
 * @param {Array}  p.visibleBatch  「所见即所改」的可见批（已按分类 + 搜索词过滤）
 * @returns {{ archivedMembers: Array, archivedCount: number, totalCount: number, allArchived: boolean, showRestore: boolean }}
 */
export function computeArchiveScope({ folderFilter, search, characters, visibleBatch }) {
  const all = Array.isArray(characters) ? characters : []
  const visible = Array.isArray(visibleBatch) ? visibleBatch : []
  const archived = all.filter(c => c.archived)

  // 恢复方向的命中集 = 作用域内的归档成员（与后端 scope 对齐；见模块头注释）
  let archivedMembers
  if (folderFilter === 'archived') {
    // 归档管理视图：可见批本身就是归档集合（搜索词继续生效，与「所见即所改」一致）
    archivedMembers = visible
  } else if (folderFilter === 'uncategorized') {
    archivedMembers = archived.filter(c => !c.folder_id)
  } else if (folderFilter === 'all') {
    // 带搜索词时动作按可见 ids 精确限定（见 currentScope()）→ 恢复方向无命中；
    // 不带搜索词 = 全库归档成员
    archivedMembers = String(search || '').trim() ? [] : archived
  } else {
    // 具体分类：该文件夹下的归档成员（后端 folder scope 不叠加搜索词）
    archivedMembers = archived.filter(c => String(c.folder_id) === String(folderFilter))
  }

  const archivedCount = archivedMembers.length
  // 总成员数 = 可见批 + 归档成员；归档管理视图两者是同一批，不重复计
  const totalCount = folderFilter === 'archived'
    ? visible.length
    : visible.length + archivedCount
  const allArchived = totalCount > 0 && archivedCount === totalCount
  return {
    archivedMembers,
    archivedCount,
    totalCount,
    allArchived,
    showRestore: archivedCount > 0 && !allArchived,
  }
}
