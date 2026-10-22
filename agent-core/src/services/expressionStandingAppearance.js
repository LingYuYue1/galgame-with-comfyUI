import { buildCharacterPersona, buildCharacterAppearanceSection } from './characterPersona.js';
import { OUTFIT_SCENES, listSceneOutfits, asPersonaOutfits, generateSceneOutfits, upsertSceneOutfits } from './outfitScene.js';

export function normalizeStandingOutfitScene(scene = 'work') {
  if (!OUTFIT_SCENES.some(item => item.key === scene)) {
    throw Object.assign(new Error('请选择有效的角色形象：默认、私服、居家或睡衣'), { status: 400 });
  }
  return scene;
}

export function hasStandingOutfit(characterId, scene) {
  return scene === 'work' || listSceneOutfits(characterId).some(row => row.scene === scene && row.description?.trim());
}

export function inspectStandingOutfits(characters, scene = 'work') {
  normalizeStandingOutfitScene(scene);
  return {
    outfitScene: scene,
    sceneLabel: scene === 'work' ? '默认' : OUTFIT_SCENES.find(row => row.key === scene).label,
    targetCount: characters.length,
    missingCharacters: characters.filter(char => !hasStandingOutfit(char.id, scene)).map(char => ({ id: char.id, name: char.display_name || char.name })),
  };
}

export function validateMissingOutfitPolicy(policy) {
  if (policy !== undefined && !['generate', 'fallback'].includes(policy)) {
    throw Object.assign(new Error('请选择自动补全服装或使用默认外观'), { status: 400 });
  }
}

export async function completeStandingOutfit(char, scene, design = generateSceneOutfits) {
  if (hasStandingOutfit(char.id, scene)) return;
  const baseAppearance = buildCharacterAppearanceSection(char, { outfits: null });
  if (!baseAppearance.trim()) throw new Error('缺少默认外观，无法自动补全服装，请先到人物详情卡填写默认外观');
  const outfits = await design(char, { scenes: [scene], baseAppearance });
  const selected = outfits.find(row => row.scene === scene && row.name?.trim() && row.description?.trim());
  if (!selected) throw new Error('自动补全未返回所选服装，请重试');
  // Never overwrite a description saved by the user while the LLM was running.
  if (!hasStandingOutfit(char.id, scene)) upsertSceneOutfits(char.id, [selected]);
}

// Explicit selection always bypasses automatic outfits, including schedule and temporary outfits.
// The detail card's default appearance lives in base_prompt; missing scene outfits use that too.
export function resolveStandingOutfits(char, scene = 'work', readOutfits = listSceneOutfits) {
  normalizeStandingOutfitScene(scene);
  /**
   * ★ 2026-10-22 修洞：原来 `scene === 'work' ? null : ...` —— work 直接返回 null，
   *   于是立绘「默认」永远不注入锚点，只用人物卡里那段旧中文外观（用户实报：花火画成粉发）。
   *
   *   现在 work 和其它场景一样，取"常服那一套"。这与头像的口径一致
   *   （`sceneOutfitParam(id,'work')`）—— 同一个「固定用常服做基准形象」不该有两个实现。
   *
   *   没有常服行时仍返回 null（退回人物卡外观段），行为与改造前一致。
   */
  // ⚠ 只认 description：`body` 是各套共用的身体描述，每行都有值 ——
  //   拿它当"这套配了没"的判据，会让"没填衣服"的套也变成已配置，注入一条只有身体的空服装。
  const outfit = readOutfits(char.id).find(row =>
    row.scene === scene && row.description?.trim());
  return asPersonaOutfits(outfit ? { outfit } : null);
}

export function buildStandingPersona(char, scene = 'work', readOutfits = listSceneOutfits) {
  return buildCharacterPersona(char, {
    variant: 'full', person: char.display_name,
    outfits: resolveStandingOutfits(char, scene, readOutfits),
    // 立绘是生图链路：只吃锚点（body + 该套服装），不拼人物卡里那段旧中文外观 —— 见角色锚点审计
    appearance: 'anchor',
  });
}
