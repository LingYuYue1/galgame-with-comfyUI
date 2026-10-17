import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref, computed } from 'vue';
import { defaultMaxTokens, isValidMaxTokens } from '../../agent-core/src/llm/modelCapabilities.js';

const source = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8');
const state = source.slice(source.indexOf("const llmBaseURL = ref("), source.indexOf('// 推荐第三方 LLM 中转站'));
const declaration = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))[0];
function fixture(fetchLlmModels = async () => ({ models: [], capabilities: {} })) {
  return new Function('ref', 'computed', 'defaultMaxTokens', 'isValidMaxTokens', 'fetchLlmModels', `
    const features = {}, backgroundConcurrency = ref(3), llmApiKeyTouched = ref(false), llmApiKey = ref('');
    const toastFn = () => {};
    ${state}
    ${declaration('loadAvailableModels')}
    ${declaration('buildLlmPayload')}
    return { llmBaseURL, llmModel, llmModelSelectVal, llmBaseURLSelectVal, llmMaxTokens, llmThinkingMode,
      llmMaxTokensValid, llmModels, llmModelsLoading, loadAvailableModels, restoreLlmMaxTokens,
      onLlmMaxTokensInput, buildLlmPayload };
  `)(ref, computed, defaultMaxTokens, isValidMaxTokens, fetchLlmModels);
}

test('official preset exposes disabled thinking and 384K; saved manual values round-trip', () => {
  const ui = fixture();
  ui.llmThinkingMode.value = 'enabled';
  ui.restoreLlmMaxTokens({ maxTokens: 12000 });
  assert.equal(ui.llmMaxTokens.value, 12000);
  assert.equal(ui.buildLlmPayload().maxTokens, 12000);
  ui.llmBaseURLSelectVal.value = 'https://api.deepseek.com';
  assert.equal(ui.llmThinkingMode.value, 'disabled');
  assert.equal(ui.llmMaxTokens.value, 393216);
  ui.llmBaseURLSelectVal.value = '';
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  assert.equal(ui.llmMaxTokens.value, 65536);
  ui.llmModelSelectVal.value = 'unknown';
  assert.equal(ui.llmMaxTokens.value, 8192);
  ui.llmMaxTokens.value = '';
  assert.equal(ui.llmMaxTokensValid.value, false);
  assert.throws(() => ui.buildLlmPayload(), /正整数/);
});

test('model capabilities fill current and subsequently selected models', async () => {
  const ui = fixture(async () => ({ models: ['deepseek-chat', 'gemini-2.5-pro'], capabilities: {
    'deepseek-chat': { maxTokens: 131072 }, 'gemini-2.5-pro': { maxTokens: 65536 },
  } }));
  await ui.loadAvailableModels();
  assert.equal(ui.llmMaxTokens.value, 131072);
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  assert.equal(ui.llmMaxTokens.value, 65536);
});

test('slow discovery cannot overwrite a manual edit or a different endpoint/profile', async () => {
  let complete;
  const ui = fixture(() => new Promise(resolve => { complete = resolve; }));
  const loading = ui.loadAvailableModels();
  ui.llmMaxTokens.value = 16000;
  ui.onLlmMaxTokensInput();
  complete({ models: ['deepseek-chat'], capabilities: { 'deepseek-chat': { maxTokens: 393216 } } });
  await loading;
  assert.equal(ui.llmMaxTokens.value, 16000);
  const stale = ui.loadAvailableModels();
  ui.llmBaseURLSelectVal.value = '';
  ui.llmModelSelectVal.value = 'gemini-2.5-pro';
  complete({ models: ['deepseek-chat'], capabilities: { 'deepseek-chat': { maxTokens: 393216 } } });
  await stale;
  assert.equal(ui.llmMaxTokens.value, 65536);
  assert.deepEqual(ui.llmModels.value, []);
  assert.equal(ui.llmModelsLoading.value, false);
});
