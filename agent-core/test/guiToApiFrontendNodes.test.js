/**
 * guiToApi 对「纯前端节点」的处理（2026-10-23）
 *
 * 起因：给银月手工调试工作流加了个 Note 说明节点，程序一跑就 400
 *   missing_node_type: Node 'Note' not found
 * —— Note / MarkdownNote 只存在于 ComfyUI 画布上，后端没有对应 class_type，
 *   必须在转换时丢掉。Reroute 本来就有处理，Note 一直是漏的。
 *
 * 这条护栏的意义：用户在 ComfyUI 里给工作流加个便签写注意事项，
 * 是再自然不过的事；程序不该因此整条链路崩掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guiToApi } from '../src/services/comfyClient.js';

/** 最小可用工作流：UNET → KSampler → VAEDecode，外加可选的前端节点 */
function buildWorkflow(extraNodes = []) {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', widgets_values: ['m.safetensors', 'default'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
      {
        id: 2, type: 'KSampler', widgets_values: [1, 'fixed', 8, 3, 'euler', 'normal', 1],
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: null },
          { name: 'negative', type: 'CONDITIONING', link: null },
          { name: 'latent_image', type: 'LATENT', link: null },
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }],
      },
      ...extraNodes,
    ],
    links: [[1, 1, 0, 2, 0, 'MODEL']],
  };
}

test('Note 不进 API（否则 ComfyUI 报 missing_node_type）', () => {
  const api = guiToApi(buildWorkflow([
    { id: 3, type: 'Note', widgets_values: ['写点注意事项'], inputs: [], outputs: [] },
  ]));
  assert.equal(Object.keys(api).length, 2);
  assert.ok(!Object.values(api).some(n => n.class_type === 'Note'));
});

test('MarkdownNote 同样不进 API', () => {
  const api = guiToApi(buildWorkflow([
    { id: 4, type: 'MarkdownNote', widgets_values: ['# 标题'], inputs: [], outputs: [] },
  ]));
  assert.ok(!Object.values(api).some(n => n.class_type === 'MarkdownNote'));
});

test('多个 Note 混在真实节点之间也不影响转换', () => {
  const api = guiToApi(buildWorkflow([
    { id: 5, type: 'Note', widgets_values: ['一'], inputs: [], outputs: [] },
    { id: 6, type: 'Note', widgets_values: ['二'], inputs: [], outputs: [] },
    { id: 7, type: 'MarkdownNote', widgets_values: ['三'], inputs: [], outputs: [] },
  ]));
  assert.deepEqual(Object.keys(api).sort(), ['1', '2']);
});

test('Reroute 既有行为不变（回归）', () => {
  const wf = buildWorkflow([
    { id: 8, type: 'Reroute', inputs: [{ name: '', type: '*', link: 2 }], outputs: [{ name: '', type: 'MODEL', links: [3] }] },
  ]);
  // 1 → Reroute(8) → 2
  wf.links = [
    [2, 1, 0, 8, 0, 'MODEL'],
    [3, 8, 0, 2, 0, 'MODEL'],
  ];
  const api = guiToApi(wf);
  assert.deepEqual(Object.keys(api).sort(), ['1', '2']);
  // KSampler.model 应穿透 Reroute 直接指到 1
  assert.deepEqual(api['2'].inputs.model, ['1', 0]);
});

test('Note 与 Reroute 同时存在：都跳过，连线仍然通', () => {
  const wf = buildWorkflow([
    { id: 9, type: 'Note', widgets_values: ['说明'], inputs: [], outputs: [] },
    { id: 10, type: 'Reroute', inputs: [{ name: '', type: '*', link: 4 }], outputs: [{ name: '', type: 'MODEL', links: [5] }] },
  ]);
  wf.links = [
    [4, 1, 0, 10, 0, 'MODEL'],
    [5, 10, 0, 2, 0, 'MODEL'],
  ];
  const api = guiToApi(wf);
  assert.deepEqual(Object.keys(api).sort(), ['1', '2']);
  assert.deepEqual(api['2'].inputs.model, ['1', 0]);
});
