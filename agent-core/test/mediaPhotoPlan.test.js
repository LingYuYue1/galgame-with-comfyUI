/**
 * F-32 回归守卫：照片题材计划 —— 配比不变 + 「轻微打散」兑现。
 *
 * ── 病是什么 ────────────────────────────────────────────────
 * `generatePhotoBatch` 里算出了 `per = n/4`，注释承诺「用 per 做一次轻微打散
 * （避免"前 n/4 全是风光"的机械感）」，实际只有一行 `void per;`（消 unused 警告）。
 * 结果：n≤8 时开头连续几张全是城市风光（n=8 时前两张 city,city），机械感真实存在。
 *
 * ── 修法 ────────────────────────────────────────────────────
 * 抽成可测试的 `buildPhotoCategoryPlan(n, allowSelfie)`，并兑现注释承诺：
 * 首段全是风光时，把段尾一个与段后首个非风光题材对调（只动 0~2 个位置）。
 *
 * 本文件钉住三条口径：①四类配比与原始规则一致（打散只换位置、不换构成）；
 * ②「存在非风光题材」时首段不全是风光；③打散足够"轻微"（与原序列的差异 ≤ 2 个位置）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`mediaPhotoPlan test forbids network: ${url}`); };

const { buildPhotoCategoryPlan } = await import('../src/services/mediaService.js');

/** 原始配比规则（未打散）——测试用的独立 oracle，不引实现做参照 */
function baselinePlan(n, allowSelfie) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const slot = i % 4;
    if (slot === 0 || slot === 1) out.push('cityscape');
    else if (slot === 2) out.push(allowSelfie ? 'selfie' : 'cityscape');
    else out.push(i % 8 === 3 ? 'food' : 'poster');
  }
  return out;
}

const count = (arr, x) => arr.filter(v => v === x).length;

test('配比不变：打散只换位置、不换构成（与原始规则逐类计数一致）', () => {
  for (let n = 1; n <= 12; n++) {
    for (const allowSelfie of [true, false]) {
      const got = buildPhotoCategoryPlan(n, allowSelfie);
      const base = baselinePlan(n, allowSelfie);
      assert.equal(got.length, n, `n=${n} 长度不对`);
      for (const k of ['cityscape', 'selfie', 'food', 'poster']) {
        assert.equal(
          count(got, k), count(base, k),
          `n=${n} allowSelfie=${allowSelfie}：「${k}」数量被改动（${count(got, k)} vs ${count(base, k)}）`,
        );
      }
      for (const c of got) {
        assert.ok(['cityscape', 'selfie', 'food', 'poster'].includes(c), `未知题材：${c}`);
      }
    }
  }
});

test('★ 首段不全是风光：存在非风光题材时，前 n/4 个不得清一色 cityscape', () => {
  for (let n = 1; n <= 12; n++) {
    for (const allowSelfie of [true, false]) {
      const got = buildPhotoCategoryPlan(n, allowSelfie);
      if (!got.some(c => c !== 'cityscape')) continue;   // 序列里压根没有非风光题材 → 无解，跳过
      const per = Math.max(1, Math.round(n / 4));
      const head = got.slice(0, per);
      assert.ok(
        !head.every(c => c === 'cityscape'),
        `n=${n} allowSelfie=${allowSelfie}：前 ${per} 个全是风光（${head.join(',')}）——注释承诺的打散没兑现`,
      );
    }
  }
});

test('打散足够「轻微」：与原始序列的差异不超过 2 个位置', () => {
  for (let n = 1; n <= 12; n++) {
    for (const allowSelfie of [true, false]) {
      const got = buildPhotoCategoryPlan(n, allowSelfie);
      const base = baselinePlan(n, allowSelfie);
      const diff = base.filter((c, i) => got[i] !== c).length;
      assert.ok(diff <= 2, `n=${n} allowSelfie=${allowSelfie}：动了 ${diff} 个位置，超出「轻微」上限`);
    }
  }
});

test('确定性：同一输入重复调用结果一致（打散不引入随机）', () => {
  for (const n of [4, 6, 8, 12]) {
    const a = JSON.stringify(buildPhotoCategoryPlan(n, true));
    const b = JSON.stringify(buildPhotoCategoryPlan(n, true));
    assert.equal(a, b, `n=${n} 两次结果不一致`);
  }
});

test('回归：n=12 本就无「首段全风光」（不打散也不应被动）', () => {
  // n=12 时前 3 个 = [city, city, selfie]，本就不全风光 → 打散应保持 0 差异
  const got = buildPhotoCategoryPlan(12, true);
  const base = baselinePlan(12, true);
  assert.deepEqual(got, base, 'n=12 不应被动过（本就满足首段约束）');
});
