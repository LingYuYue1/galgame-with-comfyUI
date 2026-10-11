import { STANDING_ROLE_PROMPTS } from '../builtinRules.js';
import { STANDING_PREFIX } from './expressionStandingPipeline.js';

// Keep the shared instructions before every request/character-specific byte.
export function buildStandingPromptMessages({ systemRules, slots, persona, requirement = '' }) {
  const examplePrompt = String.raw`Name \(Series\) has long silver hair and blue eyes. She wears a white dress, brown boots, and a gold hairpin. She stands with a gentle smile and relaxed arms.`;
  const rules = String.raw`本任务生成表情立绘提示词，使用以下专用格式：
1. Prompt写法：以角色标签 Name \(Series\) 开头，保留作品名的转义括号，随后用自然语言完整句子描述外观、表情、神态与肢体姿势；外观不另加括号。姓名、作品名、外观必须来自角色资料，禁止照抄示例或杜撰作品。
2. 每条描述来自角色资料的关键外观，包括发型、发色、瞳色、标志性服装、鞋袜及配饰或辨识特征，不设特征数量下限，不为凑数编造特征。全部提示词保持同一身份、服装、比例和普通立绘画风；每种表情配合不同姿势，正常为自然放松。
3. 表情类别只提供情绪含义，不使用 Q版、大头、半身或表情包画风。单人完整全身，头脚完整入镜，不画文字或环境。
4. 每条 prompt 为包含角色标签的英文自然语言段落，10–800 字符且不超过 80 个英文词，不出现中文；需要引用时使用单引号，不使用双引号。
5. 输出严格 JSON，顶层为 prompts 数组，每项只有 slotId 与 prompt。slotId 必须与目标槽位完全一致，每个恰好一次，不能遗漏或添加。prompt 必须为符合以上要求的非空英文字符串。
6. JSON 字符串中的反斜杠必须双写：最终提示词中的 \( 在 JSON 源码中写成 \\(。只输出 JSON，不要解释或 Markdown。`;
  return [
    { role: 'system', content: systemRules },
    { role: 'system', content: STANDING_ROLE_PROMPTS.normal },
    { role: 'system', content: `${rules}\n固定构图标签 ${STANDING_PREFIX} 由系统统一前置，不要重复输出。\n角色写法与 JSON 转义示例：\n${JSON.stringify({ prompts: [{ slotId: 'normal', prompt: examplePrompt }] }, null, 2)}` },
    { role: 'system', content: `本次全部目标槽位：${slots.map(s => `${s.id}=${s.name}`).join('；')}。\n本次完整 JSON 格式示例（必须输出全部槽位；slotId 原样保留；prompt 按前述字段约束填写对应表情的英文自然语言段落，示例角色与外观需替换为真实角色资料）：\n${JSON.stringify({ prompts: slots.map(s => ({ slotId: s.id, prompt: examplePrompt })) }, null, 2)}` },
    { role: 'system', content: `角色人格与外观资料：\n${persona}` },
    { role: 'user', content: `为上述角色生成全部目标槽位的提示词。\n额外要求：${requirement || '无'}。额外要求不得改变白底、全身、单人和角色身份这些硬性要求。` },
  ];
}
