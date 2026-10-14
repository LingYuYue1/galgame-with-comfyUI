/**
 * F-25：当前场景的图能否被「删除形象」删掉（= 是否存在该场景的**显式**立绘）。
 *
 * 背景：work（常服）槽无显式立绘时，后端以 `characters.standing_url` **兜底**呈现
 * （`listSceneStandings` 置 `is_fallback: true`，注释口径：「那张默认立绘不受影响」）。
 * 兜底图不是"该场景的立绘记录"，删它没有对象：后端 `DELETE /standings/:scene`
 * 对空记录仍无条件返回 `ok:true` → 前端照样报「形象已删除」＝**假成功**。
 *
 * 因此「删除形象」按钮只在「**有图且非兜底**」时出现；兜底态本就没有可删的对象，
 * 也不损失能力 —— 默认立绘的删除另有独立接口（`DELETE /characters/:id/standing`）。
 *
 * @param {{ image_url?: string|null, is_fallback?: boolean } | null | undefined} scene
 *        `listSceneStandings` 返回的当前场景行
 * @returns {boolean} 是否可删除显式立绘
 */
export function canRemoveSceneStanding(scene) {
  return !!scene?.image_url && !scene?.is_fallback
}
