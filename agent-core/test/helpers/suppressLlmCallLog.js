/**
 * 抑制 llm-client 的「逐次请求全量打印」—— 自动测试专用，降低 stdout 洪泛。
 *
 * ── 为什么需要（F-15 排障结论，2026-10-12）────────────────────────
 * node:test 的**进程隔离模式**对「高流量 stdout」有已知 IPC 分帧 bug：
 * 全量并发跑套件时，会随机某个文件的文件级结果反序列化失败并整文件判失败：
 *   "Unable to deserialize cloned data due to invalid or unsupported version."
 * （错误栈落在 runner 的 #processRawBuffer；即测试进程的成品 stdout 与结果通道
 *  写流竞争导致帧错位。上游 Node 生态的对应说明：高流量 stdout 场景建议
 *  隔离关掉或降低输出。）
 *
 * 我们这批「环回 HTTP 打桩 + 多次 LLM 调用」的测试是全套件里 stdout 最大的
 * （llm-client 每次调用都无差别打印完整请求 JSON），因此成了唯一反复触发者。
 *
 * ── 做什么 ────────────────────────────────────────────────────
 * 只丢掉「══════════ [provider → label]」开头的整块请求 dump
 * （banner + JSON + 分隔线在 llm-client 里是**同一条** console.log 的字符串，
 *  见 requestLog 组装处）；响应内容、usage、小标记照常打印。
 *
 * ⚠ 请求体断言不受影响：打桩服务端已把完整请求存进 llmRequests，
 *   测试断言用的是它，不是 stdout。
 */

let installed = false;

export function installLlmCallLogSuppressor() {
  if (installed) return;
  installed = true;
  const orig = console.log.bind(console);
  console.log = (...args) => {
    const first = args[0];
    // requestLog 形如 "\n══════════ [127.0.0.1 → 日程生成] ══════════\n{ ...完整请求 JSON... }"
    if (typeof first === 'string' && /^\s*═{5,} \[/.test(first)) return;
    orig(...args);
  };
}
