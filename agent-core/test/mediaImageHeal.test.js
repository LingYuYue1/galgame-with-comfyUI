/**
 * BUG-02 回归：配图卡在 pending / generating 后不自愈
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * 配图队列只在内存（`imageQueue`），触发点只有两个：生成新批次、打开传媒页。
 * 于是：进程重启 / ComfyUI 忙住 / 异常中断后，卡在 `generating` 的要等下次启动才被重置，
 * 卡在 `pending` 的**没有任何定时器会来补** —— 内容永久半成品，连失败都不记。
 *
 * ── 修法与红线 ──────────────────────────────────────────────
 * 调度器 tick 里加低频兜底：每 5 分钟最多一次、每次最多 2 张；
 * `generating` 必须卡满 30 分钟才判超时（按**本次生图开始时刻**，不是帖子 created_at）。
 * 红线来自 mediaService 的历史事故：曾每分钟无条件 fillPendingImages(8)，
 * 配合橱窗预生成把 ComfyUI 打满（30 分钟派单 46 次、同一 prompt 重生 4 次）。
 *
 * ── 本文件钉住 ──────────────────────────────────────────────
 * ① 节流：5 分钟内第二次调用不得再次补图；
 * ② 超时：刚开跑的 generating 不重置，超 30 分钟的才重置；
 * ③ 无人打开页面时 pending 也会被捞去生成（本用例把生图桩成失败，看它确实被尝试过）。
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.DB_PATH = ':memory:';
const imageModule = new URL('../src/services/imageSkill.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === imageModule) return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(`${imageModule}?actual`)};
        export const generateImageRaw = async () => ({ success: false, images: [] });`,
    };
    return nextLoad(url, context);
  },
});
globalThis.fetch = async () => { throw new Error('配图自愈测试不得访问外网'); };

const { getDb, closeDb } = await import('../src/db/index.js');
const {
  createOutlet, healStuckMediaImages, resetStaleMediaGenerating,
  __resetMediaHealThrottleForTest, __setImageClaimForTest,
} = await import('../src/services/mediaService.js');
after(() => { hooks.deregister(); closeDb(); });

function seedPost(outletId, { status = 'pending', prompt = 'a cover' } = {}) {
  return Number(getDb().prepare(`INSERT INTO media_posts
    (outlet_id, title, content, image_prompt, image_status, published_seq)
    VALUES (?, '待配图', '正文', ?, ?, NULL)`).run(outletId, prompt, status).lastInsertRowid);
}

beforeEach(() => {
  getDb().prepare('DELETE FROM media_posts').run();
  __resetMediaHealThrottleForTest();
});

test('节流：5 分钟内第二次调用不得再补图', async () => {
  const outlet = createOutlet({ name: '自愈节流', prompt: '测试', layout: 'feed' });
  const first = await healStuckMediaImages({ now: 1_000_000, force: true });
  assert.ok(first, '首次调用应当真的跑一轮');
  const second = await healStuckMediaImages({ now: 1_000_000 + 4 * 60 * 1000 });
  assert.equal(second, null, '4 分钟后仍应被节流 —— 每分钟都补会把 ComfyUI 打满（历史事故）');
  const third = await healStuckMediaImages({ now: 1_000_000 + 5 * 60 * 1000 });
  assert.ok(third, '满 5 分钟才允许再跑一轮');
  getDb().prepare('DELETE FROM media_posts WHERE outlet_id = ?').run(outlet.id);
});

test('超时判据：刚开跑的 generating 不动，卡满 30 分钟的才重置回 pending', () => {
  const db = getDb();
  const outlet = createOutlet({ name: '自愈超时', prompt: '测试', layout: 'feed' });
  const fresh = seedPost(outlet.id, { status: 'generating' });
  const stale = seedPost(outlet.id, { status: 'generating' });
  const orphan = seedPost(outlet.id, { status: 'generating' }); // 本进程没有开跑记录
  const now = Date.now();
  __setImageClaimForTest(fresh, now - 60 * 1000);              // 1 分钟前开跑
  __setImageClaimForTest(stale, now - 31 * 60 * 1000);         // 31 分钟前开跑

  const changed = resetStaleMediaGenerating({ maxAgeMs: 30 * 60 * 1000 });

  const status = id => db.prepare('SELECT image_status FROM media_posts WHERE id = ?').pluck().get(id);
  const error = id => db.prepare('SELECT image_error FROM media_posts WHERE id = ?').pluck().get(id);
  assert.equal(status(fresh), 'generating', '正在跑的不能被重置 —— 否则形成无限重生循环');
  assert.equal(status(stale), 'pending');
  assert.match(error(stale), /超过 30 分钟未完成/);
  assert.equal(status(orphan), 'pending', '没有开跑记录 = 不是本进程在跑，按卡死处理');
  assert.equal(changed, 2);
});

test('不打开传媒页也会补图：pending 被定时兜底捞走（生图桩失败 → 记 failed）', async () => {
  const db = getDb();
  const outlet = createOutlet({ name: '自愈补图', prompt: '测试', layout: 'feed' });
  const postId = seedPost(outlet.id);
  const result = await healStuckMediaImages({ force: true });
  assert.ok(result, '应当跑了一轮');
  assert.equal(result.reset, 0);
  // 生图桩恒失败：只要状态不是 pending，就说明这条**确实被尝试过**（不是没人管）。
  const row = db.prepare('SELECT image_status, image_error FROM media_posts WHERE id = ?').get(postId);
  assert.notEqual(row.image_status, 'pending');
  assert.ok(row.image_error, '失败必须留下原因，不能像原来那样 image_error 为 null');
});
