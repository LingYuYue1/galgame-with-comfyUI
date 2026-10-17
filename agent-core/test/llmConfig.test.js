import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultMaxTokens, normalizeModelCapabilities, isValidMaxTokens } from '../src/llm/modelCapabilities.js';

test('official, known text models and unknown models get appropriate defaults', () => {
  assert.equal(defaultMaxTokens('https://api.deepseek.com/v1/', 'deepseek-flash'), 393216);
  assert.equal(defaultMaxTokens('https://api.deepseek.com.evil.invalid', 'other'), 8192);
  assert.equal(defaultMaxTokens('https://relay.invalid/v1', 'deepseek-v4.1-flash'), 32768);
  for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'google/gemini-3.1-pro-preview']) {
    assert.equal(defaultMaxTokens('', model), 65536);
  }
  for (const model of ['gemini-2.0-flash', 'gemini-2.5-flash-image', 'gemini-3-live', 'unknown']) {
    assert.equal(defaultMaxTokens('', model), 8192);
  }
  for (const value of [0, -1, '', '65536', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isValidMaxTokens(value), false);
});

test('model discovery preserves output limits, never mistakes input/context limits for output limits', () => {
  const caps = normalizeModelCapabilities([
    { id: 'deepseek-flash', max_output_tokens: 393216, context_window: 1048576 },
    { name: 'models/gemini-2.5-pro', outputTokenLimit: 65536, inputTokenLimit: 1048576 },
    { id: 'relay', top_provider: { max_completion_tokens: 32768 } },
    { id: 'unknown', context_length: 1000000 },
    { id: 'invalid', max_output_tokens: -1 },
    'bare-name', null,
  ]);
  assert.deepEqual({ ...caps }, {
    'deepseek-flash': { maxTokens: 393216 }, 'gemini-2.5-pro': { maxTokens: 65536 }, relay: { maxTokens: 32768 },
  });
});

const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const settingsUrl = stub('export const values = new Map(); export const getSetting = key => values.get(key); export const setSetting = (key, value) => values.set(key, value);');
const fsUrl = stub("export let saved = ''; export default { existsSync: () => true, readFileSync: () => saved, writeFileSync: (_path, text) => { saved = text; } };");
const settings = await import(settingsUrl);
const memoryFs = await import(fsUrl);
const configUrl = new URL('../src/config.js', import.meta.url);
const imports = {
  dotenv: stub('export default { config() {} };'), fs: fsUrl,
  './db/settings.js': settingsUrl,
  './services/weatherSource.js': stub('export const notifyWeatherSourceChange = () => {};'),
  './llm/modelCapabilities.js': new URL('../src/llm/modelCapabilities.js', import.meta.url).href,
};
const source = "const fixtureEnv = {};\n" + readFileSync(configUrl, 'utf8')
  .replaceAll('process.env', 'fixtureEnv')
  .replace('fileURLToPath(import.meta.url)', JSON.stringify(fileURLToPath(configUrl)))
  .replace(/from '([^']+)'/g, (match, specifier) => imports[specifier] ? `from ${JSON.stringify(imports[specifier])}` : match);
const runtime = await import(stub(source));

test('MAX_tokens persists, round-trips profiles and survives free mode; invalid updates are rejected before mutation', () => {
  const { config, getLlmConfig, updateLlmConfig, addLlmProfile, activateLlmProfile, syncActiveLlmProfile, updateFreeEggEnabled } = runtime;
  assert.equal(getLlmConfig().maxTokens, 393216);
  assert.equal(getLlmConfig().thinkingMode, 'disabled');
  assert.equal(updateLlmConfig({ maxTokens: 65536, thinkingMode: 'enabled' }).ok, true);
  assert.match(memoryFs.saved, /LLM_MAX_TOKENS=65536/);
  assert.equal(getLlmConfig().maxTokens, 65536);
  const profile = addLlmProfile('manual').profile;
  assert.equal(profile.maxTokens, 65536);
  activateLlmProfile(profile.id);
  updateLlmConfig({ maxTokens: 12000 });
  syncActiveLlmProfile();
  updateLlmConfig({ maxTokens: 24000 });
  activateLlmProfile(profile.id);
  assert.equal(config.llm.maxTokens, 12000);
  assert.equal(config.llm.thinkingMode, 'enabled');
  updateFreeEggEnabled(true);
  assert.equal(config.llm.maxTokens, 8192);
  assert.equal(config.llm.thinkingMode, 'disabled');
  updateFreeEggEnabled(false);
  assert.equal(config.llm.maxTokens, 12000);
  assert.equal(config.llm.thinkingMode, 'enabled');
  const before = getLlmConfig();
  assert.equal(updateLlmConfig({ baseURL: 'https://wrong.invalid', maxTokens: -1 }).ok, false);
  assert.deepEqual(getLlmConfig(), before);
  settings.values.set('llm_profiles', JSON.stringify([{ id: 'legacy', name: 'old', baseURL: 'https://relay.invalid/v1', model: 'gemini-2.5-pro' }]));
  activateLlmProfile('legacy');
  assert.equal(getLlmConfig().maxTokens, 65536);
  assert.equal(getLlmConfig().thinkingMode, 'disabled');
  assert.match(memoryFs.saved, /LLM_MAX_TOKENS=65536/);
});
