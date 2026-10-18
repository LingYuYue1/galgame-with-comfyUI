import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load as yamlLoad } from 'js-yaml';
import { config, updateComfyConfig, getNovelaiApiKey, updateFeatureFlag, getLlmConfig, getLlmApiKey, updateLlmConfig, updateFreeEggEnabled, updateUserConfig, getUserConfig, updateProactiveFreq, updateEventFreq, updateMomentFreq, updateBackgroundConcurrency, updateDisturbMode, updateDisturbSettings, updateWorkflowMode, updateWorkflowScene, updateWorkflowCustomTemplate, getWorkflowConfig, getLlmProfiles, getActiveProfileId, addLlmProfile, deleteLlmProfile, activateLlmProfile, syncActiveLlmProfile, updateWeatherConfig, updateGlobalLora, updateHiresSettings, updateHiresLora, updateGroupSummaryInterval, updateGroupTemperature, updateGroupActivity, updateScheduleRefreshDays } from '../config.js';
import { resetClient, chatSync, resetFreeEggFailureCount, testLlmConnection } from '../llm/llm-client.js';
import { getDb, getSystemRules } from '../db/index.js';
import { listWorldSettings, getActiveWorldSetting, getWorldSettingById, createWorldSetting, updateWorldSetting, deleteWorldSetting, activateWorldSetting, getWorldCacheStats } from '../db/index.js';
import { DEFAULT_GLOBAL_RULES } from '../db/seedData.js';
import { restartProactiveFreq } from '../services/proactiveChatScheduler.js';
import { restartEventScheduler } from '../services/eventScheduler.js';
import { restartComfyClient } from '../services/comfyClient.js';
import { triggerDisturbCheck } from '../services/disturbModeScheduler.js';
import { restartWeatherScheduler, triggerUpdate as triggerWeatherUpdate } from '../services/weatherService.js';
import { applyFromConfig } from '../services/llmConcurrency.js';
import { BUILTIN_RULE_KEYS } from '../builtinRules.js';
import { getMemorySettings, saveMemorySettings, normalizeMemorySettings } from '../services/memory/memoryConfig.js';
import { getPreferredMemoryEmbeddingProfile, testEmbeddingProvider, testRerankerProvider } from '../services/memory/memoryProviders.js';
import { reindexAllMemories } from '../services/memory/memoryRepository.js';
import { imageUrlExists } from '../services/imagePaths.js';
import { generateImage } from '../services/imageSkill.js';
import sharp from 'sharp';

const router = Router();

// 内置官方地址（仅 DeepSeek，其余走自定义中转站）。
// 命中这些地址时视为官方直连：用于自动关闭「后台 LLM 任务队列」等仅自定义场景可用的开关。
const PRESET_LLM_URLS = ['https://api.deepseek.com'];

// GET/PUT /api/config/memory — 聊天记忆模型配置（Key 仅保存，不回显）
router.get('/memory', (_req, res) => {
  res.json({ ...getMemorySettings(), enabled: config.features.memory });
});

router.put('/memory', (req, res) => {
  try {
    const previous = getMemorySettings({ includeSecrets: true });
    const previousProfile = getPreferredMemoryEmbeddingProfile(previous).fingerprint;
    if (req.body?.enabled !== undefined) updateFeatureFlag('memory', Boolean(req.body.enabled));
    const saved = saveMemorySettings(req.body || {});
    const nextProfile = getPreferredMemoryEmbeddingProfile(saved).fingerprint;
    if (previousProfile !== nextProfile) {
      getDb().prepare(`UPDATE memory_fragments SET embedding_state = ?, embedding_error = NULL WHERE status = 'active'`)
        .run(nextProfile ? 'stale' : 'disabled');
      setImmediate(() => reindexAllMemories().catch(error => console.error('[memory] profile reindex failed:', error.message)));
    }
    res.json({ ok: true, ...getMemorySettings(), enabled: config.features.memory });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/memory/test-embedding', async (req, res) => {
  try {
    const current = getMemorySettings({ includeSecrets: true });
    const embedding = { ...current.embedding, ...(req.body || {}) };
    if (!embedding.apiKey) embedding.apiKey = current.embedding.apiKey;
    const candidate = normalizeMemorySettings({ ...current, embedding }, current);
    res.json(await testEmbeddingProvider(candidate));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post('/memory/test-reranker', async (req, res) => {
  try {
    const current = getMemorySettings({ includeSecrets: true });
    const reranker = { ...current.reranker, ...(req.body || {}) };
    if (!reranker.apiKey) reranker.apiKey = current.reranker.apiKey;
    const candidate = normalizeMemorySettings({ ...current, reranker }, current);
    res.json(await testRerankerProvider(candidate));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// GET /api/config — 获取全部配置
router.get('/', (req, res) => {
  res.json({
    comfy: {
      imageProvider: config.comfyui.imageProvider || 'comfyui',
      novelaiApiFormat: config.comfyui.novelaiApiFormat || 'relay',
      url: config.comfyui.url,
      novelaiUrl: config.comfyui.novelaiUrl,
      novelaiModel: config.comfyui.novelaiModel,
      novelaiArtist: config.comfyui.novelaiArtist ?? '',
      novelaiWidth: config.comfyui.novelaiWidth,
      novelaiHeight: config.comfyui.novelaiHeight,
      novelaiSteps: config.comfyui.novelaiSteps,
      novelaiSampler: config.comfyui.novelaiSampler,
      novelaiNoiseSchedule: config.comfyui.novelaiNoiseSchedule,
      novelaiGuidance: config.comfyui.novelaiGuidance,
      novelaiQualityPrompt: config.comfyui.novelaiQualityPrompt ?? '',
      novelaiNegativePrompt: config.comfyui.novelaiNegativePrompt ?? '',
      novelaiApiKeySet: Boolean(getNovelaiApiKey()),
      artist: config.comfyui.artist,
      width: config.comfyui.width,
      height: config.comfyui.height,
      momentsArtist: config.comfyui.momentsArtist,
      momentsWidth: config.comfyui.momentsWidth,
      momentsHeight: config.comfyui.momentsHeight,
      eventArtist: config.comfyui.eventArtist,
      eventWidth: config.comfyui.eventWidth,
      eventHeight: config.comfyui.eventHeight,
      qualityPrompt: config.comfyui.qualityPrompt ?? '',
      negativePrompt: config.comfyui.negativePrompt ?? '',
      tlsVerify: config.comfyui.tlsVerify,
      globalLora: config.comfyui.globalLora || [],
      hiresSamplingMode: config.comfyui.hiresSamplingMode,
      hiresGlobalLoraScale: config.comfyui.hiresGlobalLoraScale,
      hiresSourceBlend: config.comfyui.hiresSourceBlend,
      hiresUpscaleModel: config.comfyui.hiresUpscaleModel,
      hiresWorkflowMode: config.comfyui.hiresWorkflowMode,
      hiresLora: config.comfyui.hiresLora || [],
      hiresSteps: config.comfyui.hiresSteps ?? 35,
      hiresCfg: config.comfyui.hiresCfg ?? 5.0,
      hiresDenoise: config.comfyui.hiresDenoise ?? 0.2,
      hiresMaxSize: config.comfyui.hiresMaxSize ?? 2000,
      hiresArtistMode: config.comfyui.hiresArtistMode ?? 'empty',
      hiresArtist: config.comfyui.hiresArtist ?? '',
    },
    features: config.features,
    weather: { city: config.weather.city || '' },
    llm: getLlmConfig(),
    llmProfiles: getLlmProfiles(),
    activeLlmProfileId: getActiveProfileId(),
    disturb: {
      startTime: config.disturb.startTime,
      endTime: config.disturb.endTime,
      characterIds: config.disturb.characterIds || [],
      hideWorld: config.disturb.hideWorld || false,
      skipWeekends: config.disturb.skipWeekends || false,
    },
    workflow: getWorkflowConfig(),
    groupChat: {
      activity: config.groupChat?.activity ?? 2,
      temperature: config.groupChat?.temperature ?? 0.7,
      summaryInterval: config.groupChat?.summaryInterval ?? 4,
    },
  });
});

// PUT /api/config/group-activity — 群聊活跃度 1~5（所有群共享）
router.put('/group-activity', (req, res) => {
  const value = req.body?.value;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return res.status(400).json({ error: 'value must be an integer from 1 to 5' });
  }
  res.json({ ok: true, activity: updateGroupActivity(value) });
});

// PUT /api/config/group-temperature — 更新群聊 LLM 温度 0.5~1.2（所有群共享）
router.put('/group-temperature', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'number' || value < 0.5 || value > 1.2) {
    return res.status(400).json({ error: 'value must be 0.5~1.2' });
  }
  updateGroupTemperature(value);
  res.json({ ok: true, temperature: config.groupChat.temperature });
});

// PUT /api/config/group-summary-interval — 更新群聊记忆总结/滑动窗口推进轮次 2~6（所有群共享）
router.put('/group-summary-interval', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'number' || value < 2 || value > 6) {
    return res.status(400).json({ error: 'value must be 2~6' });
  }
  updateGroupSummaryInterval(value);
  res.json({ ok: true, summaryInterval: config.groupChat.summaryInterval });
});

// PUT /api/config/comfy — 更新 ComfyUI 参数
router.put('/comfy', (req, res) => {
  const { artist, width, height, url, momentsArtist, momentsWidth, momentsHeight, eventArtist, eventWidth, eventHeight, tlsVerify, qualityPrompt, negativePrompt, imageProvider, novelaiApiFormat, novelaiUrl, novelaiModel, novelaiArtist, novelaiWidth, novelaiHeight, novelaiSteps, novelaiSampler, novelaiNoiseSchedule, novelaiGuidance, novelaiQualityPrompt, novelaiNegativePrompt, novelaiApiKey, clearNovelaiApiKey } = req.body;
  if (novelaiApiFormat !== 'official' && novelaiUrl !== undefined && String(novelaiUrl).trim()) {
    try {
      const parsed = new URL(String(novelaiUrl));
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    } catch {
      return res.status(400).json({ error: 'NovelAI 地址必须是有效的 HTTP 或 HTTPS URL' });
    }
  }
  updateComfyConfig({ artist, width, height, url, momentsArtist, momentsWidth, momentsHeight, eventArtist, eventWidth, eventHeight, tlsVerify, qualityPrompt, negativePrompt, imageProvider, novelaiApiFormat, novelaiUrl, novelaiModel, novelaiArtist, novelaiWidth, novelaiHeight, novelaiSteps, novelaiSampler, novelaiNoiseSchedule, novelaiGuidance, novelaiQualityPrompt, novelaiNegativePrompt, novelaiApiKey, clearNovelaiApiKey });
  // URL 或 TLS 设置变更后立即重启 ComfyUI 客户端连接（使新地址/证书策略立即生效）
  if (url !== undefined || tlsVerify !== undefined) {
    restartComfyClient();
  }
  res.json({ ok: true, imageProvider: config.comfyui.imageProvider, novelaiApiFormat: config.comfyui.novelaiApiFormat, url: config.comfyui.url, novelaiUrl: config.comfyui.novelaiUrl, novelaiModel: config.comfyui.novelaiModel, novelaiArtist: config.comfyui.novelaiArtist, novelaiWidth: config.comfyui.novelaiWidth, novelaiHeight: config.comfyui.novelaiHeight, novelaiSteps: config.comfyui.novelaiSteps, novelaiSampler: config.comfyui.novelaiSampler, novelaiNoiseSchedule: config.comfyui.novelaiNoiseSchedule, novelaiGuidance: config.comfyui.novelaiGuidance, novelaiQualityPrompt: config.comfyui.novelaiQualityPrompt, novelaiNegativePrompt: config.comfyui.novelaiNegativePrompt, novelaiApiKeySet: Boolean(getNovelaiApiKey()) });
});

// PUT /api/config/global-lora — 更新全局 LoRA
router.put('/global-lora', (req, res) => {
  const { loras } = req.body;
  if (loras === undefined) {
    return res.status(400).json({ error: 'loras is required' });
  }
  updateGlobalLora(loras);
  res.json({ ok: true, globalLora: config.comfyui.globalLora });
});

// PUT /api/config/hires-lora — 更新 HiresFix 细化专用 LoRA（仅作用于放大细化工作流）
router.put('/hires-lora', (req, res) => {
  const { loras } = req.body;
  if (loras === undefined) {
    return res.status(400).json({ error: 'loras is required' });
  }
  updateHiresLora(loras);
  res.json({ ok: true, hiresLora: config.comfyui.hiresLora });
});

// PUT /api/config/hires — 更新 HiresFix 细化完整设置（LoRA + 步数/重绘幅度/CFG/最长边/画师串）
router.put('/hires', (req, res) => {
  const { loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode } = req.body || {};
  if (loras === undefined && steps === undefined && cfg === undefined && denoise === undefined && maxSize === undefined && artistMode === undefined && artist === undefined && samplingMode === undefined && globalLoraScale === undefined && sourceBlend === undefined && upscaleModel === undefined && workflowMode === undefined) {
    return res.status(400).json({ error: 'at least one hires setting is required' });
  }
  updateHiresSettings({ loras, steps, cfg, denoise, maxSize, artistMode, artist, samplingMode, globalLoraScale, sourceBlend, upscaleModel, workflowMode });
  res.json({
    ok: true,
    hiresLora: config.comfyui.hiresLora,
    hiresSamplingMode: config.comfyui.hiresSamplingMode,
    hiresGlobalLoraScale: config.comfyui.hiresGlobalLoraScale,
    hiresSourceBlend: config.comfyui.hiresSourceBlend,
    hiresUpscaleModel: config.comfyui.hiresUpscaleModel,
    hiresWorkflowMode: config.comfyui.hiresWorkflowMode,
    hiresSteps: config.comfyui.hiresSteps,
    hiresCfg: config.comfyui.hiresCfg,
    hiresDenoise: config.comfyui.hiresDenoise,
    hiresMaxSize: config.comfyui.hiresMaxSize,
    hiresArtistMode: config.comfyui.hiresArtistMode,
    hiresArtist: config.comfyui.hiresArtist,
  });
});

// PUT /api/config/features — 更新功能开关
router.put('/features', (req, res) => {
  const { key, value } = req.body;
  if (!key || !(key in config.features)) {
    return res.status(400).json({ error: `Invalid feature key: ${key}` });
  }
  updateFeatureFlag(key, value);
  if (key === 'serializeBackgroundLLM') {
    applyFromConfig(config);
  }
  if (key === 'weather' && value === true) {
    // restartWeatherScheduler 内部会立即 tick() 一次，无需再手动触发拉取
    restartWeatherScheduler();
  }
  res.json({ ok: true, features: config.features });
});

// PUT /api/config/proactive-freq — 更新主动聊天频率 0~1
router.put('/proactive-freq', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'number' || value < 0 || value > 1) {
    return res.status(400).json({ error: 'value must be 0~1' });
  }
  updateProactiveFreq(value);
  restartProactiveFreq();
  res.json({ ok: true, proactiveChatFreq: config.features.proactiveChatFreq });
});

// PUT /api/config/event-freq — 更新奇遇触发频率 0~1
router.put('/event-freq', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'number' || value < 0 || value > 1) {
    return res.status(400).json({ error: 'value must be 0~1' });
  }
  updateEventFreq(value);
  restartEventScheduler();
  res.json({ ok: true, eventFreq: config.features.eventFreq });
});

// PUT /api/config/moment-freq — 具体时间档 ±20%，mode 区分默认与 2 小时档
router.put('/moment-freq', (req, res) => {
  const { value, mode } = req.body;
  if (!Number.isFinite(value) || value < 0 || value > 24) {
    return res.status(400).json({ error: 'value must be 0~24' });
  }
  if (mode !== undefined && (mode !== 'default' && mode !== 'interval' || mode === 'default' && value !== 1)) {
    return res.status(400).json({ error: 'mode must be interval, or default with value=1' });
  }
  updateMomentFreq(value, mode);
  res.json({ ok: true, momentFreq: config.features.momentFreq, momentFreqMode: config.features.momentFreqMode });
});

// PUT /api/config/schedule-refresh-days — 更新日程刷新周期（天，1~3）
router.put('/schedule-refresh-days', (req, res) => {
  const { value } = req.body;
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 3) {
    return res.status(400).json({ error: 'value must be an integer 1~3' });
  }
  updateScheduleRefreshDays(n);
  res.json({ ok: true, scheduleRefreshDays: config.features.scheduleRefreshDays });
});

// PUT /api/config/background-llm-concurrency — 更新后台 LLM 并发数 1~10
router.put('/background-llm-concurrency', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'number' || value < 1 || value > 10) {
    return res.status(400).json({ error: 'value must be 1~10' });
  }
  updateBackgroundConcurrency(value);
  applyFromConfig(config);
  res.json({ ok: true, backgroundLLMMaxConcurrency: config.features.backgroundLLMMaxConcurrency });
});

// PUT /api/config/llm — 更新 LLM 配置
router.put('/llm', (req, res) => {
  const { apiKey, baseURL, model, thinkingMode, headers, extraBody } = req.body;
  const result = updateLlmConfig({ apiKey, baseURL, model, thinkingMode, headers, extraBody });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  resetClient();

  const effectiveUrl = baseURL || config.llm.baseURL;
  if (effectiveUrl && PRESET_LLM_URLS.includes(effectiveUrl) && config.features.serializeBackgroundLLM) {
    updateFeatureFlag('serializeBackgroundLLM', false);
    console.log('[config] serializeBackgroundLLM auto-disabled (preset LLM selected)');
  }

  syncActiveLlmProfile();

  res.json({ ok: true, ...getLlmConfig() });
});

// PUT /api/config/llm/free-egg — 每日免费鸡蛋开关（opencode zen 免费端点，免 Key）
router.put('/llm/free-egg', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  updateFreeEggEnabled(enabled);
  resetFreeEggFailureCount();
  resetClient();
  res.json({ ok: true, ...getLlmConfig() });
});

// GET /api/config/llm/key — 获取当前 LLM API Key（前端复制用）
// 明文 Key 属敏感信息，仅限本机回环调用（手机端仍可从 /api/config 看到脱敏预览）
router.get('/llm/key', (req, res) => {
  const addr = req.socket?.remoteAddress || '';
  const isLoopback = addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
  if (!isLoopback) {
    return res.status(403).json({ ok: false, error: 'API Key 明文仅允许本机获取' });
  }
  const apiKey = getLlmApiKey();
  if (!apiKey) {
    return res.status(404).json({ ok: false, error: '未设置 API Key' });
  }
  res.json({ ok: true, apiKey });
});

// POST /api/config/llm/models — 从 OpenAI-compatible 接口获取可用模型
// POST /api/config/llm/test — 使用当前或表单 LLM 配置测试一次最小对话请求
router.post('/llm/test', async (req, res) => {
  try {
    const result = await testLlmConnection({
      baseURL: req.body?.baseURL || config.llm.baseURL,
      apiKey: req.body?.apiKey || config.llm.apiKey,
      model: req.body?.model || config.llm.model,
      headers: req.body?.headers || config.llm.headers,
      extraBody: req.body?.extraBody || config.llm.extraBody,
    });
    res.json(result);
  } catch (error) {
    const status = error?.status || error?.response?.status || 502;
    const rawDetail = error?.error?.message || error?.message || 'LLM 连接测试失败';
    const unstablePattern = /no body|status code|fetch failed|timeout|abort|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i;
    const detail = status >= 500 || unstablePattern.test(rawDetail)
      ? `${rawDetail}。这通常是上游服务未响应或暂时超时，建议稍后重试。`
      : rawDetail;
    res.status(status >= 400 && status < 600 ? status : 502).json({ ok: false, error: detail });
  }
});

router.post('/llm/models', async (req, res) => {
  const baseURL = String(req.body?.baseURL || config.llm.baseURL || '').trim().replace(/\/+$/, '');
  if (!baseURL) return res.status(400).json({ error: '请先填写 API 地址' });

  let modelsURL;
  try {
    modelsURL = new URL(`${baseURL}/models`);
    if (!['http:', 'https:'].includes(modelsURL.protocol)) throw new Error('unsupported protocol');
  } catch {
    return res.status(400).json({ error: 'API 地址格式无效' });
  }

  const apiKey = String(req.body?.apiKey || config.llm.apiKey || '').trim();
  const customHeaders = req.body?.headers && typeof req.body.headers === 'object' && !Array.isArray(req.body.headers)
    ? req.body.headers
    : {};
  const requestHeaders = {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...customHeaders,
  };

  try {
    const response = await fetch(modelsURL, {
      method: 'GET',
      headers: requestHeaders,
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      return res.status(502).json({ error: `模型列表请求失败：${detail}` });
    }

    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];
    const models = [...new Set(rows
      .map(item => typeof item === 'string' ? item : item?.id || item?.name)
      .filter(Boolean)
      .map(id => String(id).replace(/^models\//, '')))]
      .sort((a, b) => a.localeCompare(b));

    if (!models.length) {
      return res.status(502).json({ error: '接口未返回可识别的模型列表' });
    }
    res.json({ ok: true, models, endpoint: modelsURL.toString() });
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '请求超时' : error.message;
    res.status(502).json({ error: `获取模型失败：${message}` });
  }
});

// ── LLM Profile 管理 ──

// GET /api/config/llm/profiles — 获取所有 profile
router.get('/llm/profiles', (req, res) => {
  res.json({ profiles: getLlmProfiles(), activeProfileId: getActiveProfileId() });
});

// POST /api/config/llm/profiles — 新增 profile（默认快照当前 LLM 配置，可传字段覆盖）
router.post('/llm/profiles', (req, res) => {
  const { name, ...overrides } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const result = addLlmProfile(name, overrides);
  res.json({ ok: true, profiles: getLlmProfiles(), activeProfileId: getActiveProfileId() });
});

// DELETE /api/config/llm/profiles/:id — 删除 profile
router.delete('/llm/profiles/:id', (req, res) => {
  const result = deleteLlmProfile(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  resetClient();
  res.json({ ok: true, profiles: getLlmProfiles(), activeProfileId: getActiveProfileId() });
});

// POST /api/config/llm/profiles/:id/activate — 切换激活 profile
router.post('/llm/profiles/:id/activate', (req, res) => {
  const result = activateLlmProfile(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  resetClient();

  // preset 检测：与 PUT /api/config/llm 一致
  if (PRESET_LLM_URLS.includes(config.llm.baseURL) && config.features.serializeBackgroundLLM) {
    updateFeatureFlag('serializeBackgroundLLM', false);
  }

  res.json({ ok: true, llmConfig: getLlmConfig(), profiles: getLlmProfiles(), activeProfileId: getActiveProfileId() });
});

// PUT /api/config/llm/profiles/active/sync — 同步当前配置到激活的 profile
router.put('/llm/profiles/active/sync', (req, res) => {
  syncActiveLlmProfile();
  res.json({ ok: true });
});

// GET /api/config/rules — 获取全部全局规则
router.get('/rules', (req, res) => {
  const db = getDb();
  const rules = db.prepare(`SELECT id, rule_key, rule_content, is_active, created_at, updated_at FROM global_rules ORDER BY id`).all();
  res.json({ rules: rules.filter(r => !BUILTIN_RULE_KEYS.has(r.rule_key)) });
});

// PUT /api/config/rules/:key — 更新或新建单条全局规则
router.put('/rules/:key', (req, res) => {
  if (BUILTIN_RULE_KEYS.has(req.params.key)) {
    return res.status(403).json({ error: 'This rule is now built-in and cannot be modified via API.' });
  }
  const db = getDb();
  const { rule_content, is_active } = req.body;
  const existing = db.prepare(`SELECT id FROM global_rules WHERE rule_key = ?`).get(req.params.key);
  if (!existing) {
    // 不存在则新建
    const content = rule_content !== undefined ? rule_content : '';
    const active = is_active !== undefined ? (is_active ? 1 : 0) : 1;
    const result = db.prepare(
      `INSERT INTO global_rules (rule_key, rule_content, is_active) VALUES (?, ?, ?)`
    ).run(req.params.key, content, active);
    const created = db.prepare(`SELECT * FROM global_rules WHERE id = ?`).get(result.lastInsertRowid);
    return res.json({ ok: true, rule: created });
  }
  const updates = [];
  const params = [];
  if (rule_content !== undefined) { updates.push('rule_content = ?'); params.push(rule_content); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.key);
  db.prepare(`UPDATE global_rules SET ${updates.join(', ')} WHERE rule_key = ?`).run(...params);
  const updated = db.prepare(`SELECT * FROM global_rules WHERE rule_key = ?`).get(req.params.key);
  res.json({ ok: true, rule: updated });
});

// GET /api/config/user — 获取用户昵称 + 自我设定
router.get('/user', (req, res) => {
  res.json(getUserConfig());
});

// PUT /api/config/user — 更新用户昵称 + 性别 + 外观 + 其他说明 + 居住地点
router.put('/user', (req, res) => {
  const { nickname, gender, appearance, persona, home } = req.body;
  updateUserConfig({ nickname, gender, appearance, persona, home });
  res.json({ ok: true, ...getUserConfig() });
});

// GET /api/config/user-avatar — 获取用户头像路径
router.get('/user-avatar', (req, res) => {
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.dirname(path.dirname(path.dirname(__filename)));
  const avatarDir = path.join(projectRoot, 'data', 'avatars');
  const userAvatarPath = path.join(avatarDir, 'user_avatar.png');
  if (fs.existsSync(userAvatarPath)) {
    const mtime = fs.statSync(userAvatarPath).mtimeMs;
    res.json({ avatar_path: `/avatars/user_avatar.png?v=${mtime}` });
  } else {
    res.json({ avatar_path: null });
  }
});

// POST /api/config/user-avatar — 上传用户头像（base64）
router.post('/user-avatar', (req, res) => {
  const { base64 } = req.body;
  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = path.dirname(path.dirname(path.dirname(__filename)));
  const avatarDir = path.join(projectRoot, 'data', 'avatars');
  fs.mkdirSync(avatarDir, { recursive: true });

  // null / 空字符串 = 删除头像
  if (!base64) {
    const userAvatarPath = path.join(avatarDir, 'user_avatar.png');
    try { if (fs.existsSync(userAvatarPath)) fs.unlinkSync(userAvatarPath); } catch {}
    return res.json({ ok: true, avatar_path: null });
  }

  const filePath = path.join(avatarDir, 'user_avatar.png');
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  const mtime = fs.statSync(filePath).mtimeMs;

  res.json({ ok: true, avatar_path: `/avatars/user_avatar.png?v=${mtime}` });
});

// GET /api/config/loras-files — 从 launcher_config.json 读取 comfyui_exe，推导 loras 文件夹，并解析 extra_model_paths.yaml 获取外部路径
router.get('/loras-files', (req, res) => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const projectRoot = path.dirname(path.dirname(path.dirname(__filename)));
    const launcherConfigPath = path.join(projectRoot, '..', 'launcher_config.json');

    if (!fs.existsSync(launcherConfigPath)) {
      return res.json({ files: [], lorasDir: null, error: 'launcher_config.json 不存在，请先在启动器中配置 ComfyUI 路径' });
    }

    const launcherConfig = JSON.parse(fs.readFileSync(launcherConfigPath, 'utf-8'));
    const comfyuiExe = launcherConfig.comfyui_exe;
    if (!comfyuiExe) {
      return res.json({ files: [], lorasDir: null, error: 'comfyui_exe 未配置，请先在启动器中设置 ComfyUI 启动器路径' });
    }

    const rootDir = path.dirname(comfyuiExe);
    const defaultLoraDir = path.join(rootDir, 'ComfyUI', 'models', 'loras');

    // 收集所有待扫描目录
    const scanDirs = new Set();
    const dirSourceMap = new Map(); // absPath → source groupName

    if (fs.existsSync(defaultLoraDir)) {
      scanDirs.add(defaultLoraDir);
    }

    // 读取额外 LoRA 文件夹（launcher_config.json 中的 extra_lora_folders，多个用;分隔）
    const extraFoldersStr = launcherConfig.extra_lora_folders;
    if (extraFoldersStr && typeof extraFoldersStr === 'string') {
      extraFoldersStr.split(';').map(s => s.trim()).filter(Boolean).forEach(folder => {
        const absPath = path.resolve(folder);
        if (fs.existsSync(absPath)) {
          scanDirs.add(absPath);
          dirSourceMap.set(absPath, 'custom');
        }
      });
    }

    // 解析 extra_model_paths.yaml（可能在 rootDir 或 rootDir/ComfyUI 下）
    let yamlPath = path.join(rootDir, 'extra_model_paths.yaml');
    if (!fs.existsSync(yamlPath)) {
      yamlPath = path.join(rootDir, 'ComfyUI', 'extra_model_paths.yaml');
    }
    if (fs.existsSync(yamlPath)) {
      const yamlDir = path.dirname(yamlPath);
      try {
        const yamlContent = yamlLoad(fs.readFileSync(yamlPath, 'utf-8'));
        if (yamlContent && typeof yamlContent === 'object') {
          for (const [groupName, groupConfig] of Object.entries(yamlContent)) {
            if (!groupConfig || typeof groupConfig !== 'object') continue;
            const basePath = groupConfig.base_path;
            const lorasField = groupConfig.loras;
            if (!basePath || lorasField === undefined) continue;

            const lorasValues = Array.isArray(lorasField)
              ? lorasField
              : typeof lorasField === 'string' ? [lorasField] : [];

            for (const lv of lorasValues) {
              if (typeof lv !== 'string') continue;
              const lines = lv.split('\n').map(s => s.trim()).filter(Boolean);
              for (const line of lines) {
                const absPath = path.resolve(yamlDir, basePath, line === '.' ? '.' : line);
                if (fs.existsSync(absPath)) {
                  scanDirs.add(absPath);
                  dirSourceMap.set(absPath, groupName);
                }
              }
            }
          }
        }
      } catch (yamlErr) {
        console.warn('[loras-files] extra_model_paths.yaml 解析失败，仅扫描默认目录:', yamlErr.message);
      }
    }

    // 遍历所有目录收集 .safetensors 文件
    const files = [];
    const seen = new Set();

    function walkDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) {
          const relToDefault = path.relative(defaultLoraDir, fullPath);
          const isDefault = !relToDefault.startsWith('..') && !path.isAbsolute(relToDefault);

          if (isDefault) {
            const name = relToDefault;
            if (!seen.has(name)) {
              seen.add(name);
              files.push({ name, path: fullPath, source: null });
            }
          } else {
            const name = entry.name;
            let source = 'unknown';
            for (const [absPath, groupName] of dirSourceMap) {
              const rel = path.relative(absPath, fullPath);
              if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                source = groupName;
                break;
              }
            }
            const key = name + '|' + source;
            if (!seen.has(key)) {
              seen.add(key);
              files.push({ name, path: fullPath, source });
            }
          }
        }
      }
    }

    for (const dir of scanDirs) {
      walkDir(dir);
    }

    files.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[loras-files] ${files.length} files from ${scanDirs.size} dir(s)`);

    res.json({ files, lorasDir: defaultLoraDir });
  } catch (err) {
    res.status(500).json({ files: [], lorasDir: null, error: err.message });
  }
});

// ── 画师串收藏夹 ──

// GET /api/config/artist-favorites
router.get('/artist-favorites', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, label, artist, sort_order, created_at FROM artist_favorites ORDER BY sort_order, created_at DESC`
  ).all();
  res.json({ favorites: rows });
});

// POST /api/config/artist-favorites
router.post('/artist-favorites', (req, res) => {
  const db = getDb();
  const { label, artist } = req.body;
  if (!label || !artist) {
    return res.status(400).json({ error: 'label and artist are required' });
  }
  // 去重检查
  const existing = db.prepare(`SELECT id FROM artist_favorites WHERE artist = ?`).get(artist.trim());
  if (existing) {
    return res.status(409).json({ error: 'duplicate', id: existing.id });
  }
  const result = db.prepare(
    `INSERT INTO artist_favorites (label, artist) VALUES (?, ?)`
  ).run(label.trim(), artist.trim());
  const row = db.prepare(`SELECT * FROM artist_favorites WHERE id = ?`).get(result.lastInsertRowid);
  res.json({ ok: true, favorite: row });
});

// PUT /api/config/artist-favorites/:id
router.put('/artist-favorites/:id', (req, res) => {
  const db = getDb();
  const { label, artist } = req.body;
  const existing = db.prepare(`SELECT id FROM artist_favorites WHERE id = ?`).get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Favorite not found' });
  }
  const updates = [];
  const params = [];
  if (label !== undefined) { updates.push('label = ?'); params.push(label.trim()); }
  if (artist !== undefined) { updates.push('artist = ?'); params.push(artist.trim()); }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }
  params.push(req.params.id);
  db.prepare(`UPDATE artist_favorites SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare(`SELECT * FROM artist_favorites WHERE id = ?`).get(req.params.id);
  res.json({ ok: true, favorite: updated });
});

// DELETE /api/config/artist-favorites/:id
router.delete('/artist-favorites/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM artist_favorites WHERE id = ?`).get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Favorite not found' });
  }
  db.prepare(`DELETE FROM artist_favorites WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ── 防打扰模式 ──

// PUT /api/config/disturb-mode — 更新防打扰模式总开关
router.put('/disturb-mode', (req, res) => {
  const { value } = req.body;
  if (value == null || typeof value !== 'boolean') {
    return res.status(400).json({ error: 'value must be boolean' });
  }
  updateDisturbMode(value);
  // 总开关变更后立即触发一次检测
  triggerDisturbCheck();
  res.json({ ok: true, disturbMode: config.features.disturbMode });
});

// PUT /api/config/workflow-mode — 更新工作流模式 (base|turbo|hybrid|custom)
// mode === 'custom' 时可同时传 customTemplate（workflow/ 目录下的文件名）
router.put('/workflow-mode', (req, res) => {
  const { mode, customTemplate } = req.body;
  if (!mode || !['base', 'turbo', 'hybrid', 'custom'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be base, turbo, hybrid, or custom' });
  }
  if (customTemplate !== undefined) {
    const customResult = updateWorkflowCustomTemplate(customTemplate);
    if (!customResult.ok) return res.status(400).json(customResult);
  }
  const result = updateWorkflowMode(mode);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, workflow: getWorkflowConfig() });
});

// PUT /api/config/workflow-scene — 更新 hybrid 模式下场景→工作流映射
router.put('/workflow-scene', (req, res) => {
  const { scene } = req.body;
  const result = updateWorkflowScene(scene);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, workflow: getWorkflowConfig() });
});

// PUT /api/config/disturb-settings — 更新防打扰时间段和角色列表
router.put('/disturb-settings', (req, res) => {
  const { startTime, endTime, characterIds, hideWorld, skipWeekends } = req.body;
  if (startTime !== undefined && !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'startTime must be HH:MM format' });
  }
  if (endTime !== undefined && !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ error: 'endTime must be HH:MM format' });
  }
  if (characterIds !== undefined && !Array.isArray(characterIds)) {
    return res.status(400).json({ error: 'characterIds must be an array' });
  }
  if (hideWorld !== undefined && typeof hideWorld !== 'boolean') {
    return res.status(400).json({ error: 'hideWorld must be boolean' });
  }
  if (skipWeekends !== undefined && typeof skipWeekends !== 'boolean') {
    return res.status(400).json({ error: 'skipWeekends must be boolean' });
  }
  updateDisturbSettings({ startTime, endTime, characterIds, hideWorld, skipWeekends });
  // 设置变更后立即触发一次检测
  triggerDisturbCheck();
  res.json({
    ok: true,
    disturb: {
      startTime: config.disturb.startTime,
      endTime: config.disturb.endTime,
      characterIds: config.disturb.characterIds || [],
      hideWorld: config.disturb.hideWorld || false,
      skipWeekends: config.disturb.skipWeekends || false,
    },
  });
});

// GET /api/config/rules/:key/default — 获取单条规则的默认值（不修改，仅供预览）
router.get('/rules/:key/default', (req, res) => {
  if (BUILTIN_RULE_KEYS.has(req.params.key)) {
    return res.status(403).json({ error: 'This rule is now built-in and cannot be modified via API.' });
  }
  const defaultRule = DEFAULT_GLOBAL_RULES.find(r => r.rule_key === req.params.key);
  if (!defaultRule) {
    return res.status(404).json({ error: `No default value for rule key: ${req.params.key}` });
  }
  res.json({ ok: true, rule_key: defaultRule.rule_key, rule_content: defaultRule.rule_content });
});

// POST /api/config/rules/:key/reset — 重置单条全局规则为默认值
router.post('/rules/:key/reset', (req, res) => {
  if (BUILTIN_RULE_KEYS.has(req.params.key)) {
    return res.status(403).json({ error: 'This rule is now built-in and cannot be modified via API.' });
  }
  const db = getDb();
  const defaultRule = DEFAULT_GLOBAL_RULES.find(r => r.rule_key === req.params.key);
  if (!defaultRule) {
    return res.status(404).json({ error: `No default value for rule key: ${req.params.key}` });
  }
  const existing = db.prepare(`SELECT id FROM global_rules WHERE rule_key = ?`).get(req.params.key);
  if (!existing) {
    // 规则不存在则用默认值新建
    const result = db.prepare(
      `INSERT INTO global_rules (rule_key, rule_content, is_active) VALUES (?, ?, 1)`
    ).run(req.params.key, defaultRule.rule_content);
    const created = db.prepare(`SELECT * FROM global_rules WHERE id = ?`).get(result.lastInsertRowid);
    return res.json({ ok: true, rule: created });
  }
  db.prepare(
    `UPDATE global_rules SET rule_content = ?, updated_at = datetime('now') WHERE rule_key = ?`
  ).run(defaultRule.rule_content, req.params.key);
  const updated = db.prepare(`SELECT * FROM global_rules WHERE rule_key = ?`).get(req.params.key);
  res.json({ ok: true, rule: updated });
});

// ── 世界观收藏 ──

// GET /api/world-settings — 获取全部世界观列表
router.get('/world-settings', (req, res) => {
  res.json({ list: listWorldSettings() });
});

// POST /api/world-settings — 创建新世界观
router.post('/world-settings', (req, res) => {
  const { name, content, tagline } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const item = createWorldSetting({
    name: name.trim(),
    content: content?.trim() || '',
    tagline: typeof tagline === 'string' ? tagline.trim() : '',
  });
  res.json({ ok: true, item });
});

// PUT /api/world-settings/:id — 编辑某个世界观（含星图新字段：tagline / visual_tone / is_enabled）
router.put('/world-settings/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || !getWorldSettingById(id)) return res.status(404).json({ error: 'not found' });
  const { name, content, tagline, visual_tone, is_enabled, cover_image } = req.body;
  // 注：name/content 用 typeof 判定而非 !== undefined —— 老前端可能传 null，
  // 原实现 `name?.trim()` 能容忍 null，这里保持同等宽容度（null 视作"不改"）。
  const item = updateWorldSetting(id, {
    name: typeof name === 'string' ? name.trim() : undefined,
    content: typeof content === 'string' ? content.trim() : undefined,
    tagline: typeof tagline === 'string' ? tagline.trim() : undefined,
    visual_tone: typeof visual_tone === 'string' ? visual_tone.trim() : undefined,
    is_enabled: is_enabled === undefined ? undefined : !!is_enabled,
    // 空串 = 清除封面（与 tagline 同口径：字符串才认，null/缺省 = 不改）
    cover_image: typeof cover_image === 'string' ? cover_image.trim() : undefined,
  });
  res.json({ ok: true, item });
});

// GET /api/recent-images — 全站近期生成的图（供世界封面挑选）
//
// 为什么不是复用 `/characters/:id/recent-images`：那个接口按**角色**聚合，需要角色 id；
// 而世界封面是世界级的，跟任何角色都没有关系。这里直接读 `image_tasks`（全站图的登记表），
// 按完成时间倒序、URL 去重、并过滤掉磁盘上已经不存在的（重生成会替换删除旧文件）。
//
// 不带世界过滤：用户要的是"近期生成的"，跨角色跨世界的图都可能被拿来当封面。
router.get('/recent-images', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 40));
    const db = getDb();
    // 多取一些行 —— 一行可能有多张图，且会有重复 URL 与已删文件
    const rows = db.prepare(`
      SELECT output_paths FROM image_tasks
      WHERE status = 'done' AND output_paths IS NOT NULL
      ORDER BY COALESCE(finished_at, created_at) DESC
      LIMIT ?
    `).all(limit * 3);

    const seen = new Set();
    const images = [];
    for (const row of rows) {
      let arr = [];
      try { arr = JSON.parse(row.output_paths) || []; } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const u of arr) {
        if (typeof u !== 'string' || !u.trim() || seen.has(u)) continue;
        seen.add(u);
        if (!imageUrlExists(u)) continue;
        images.push(u);
        if (images.length >= limit) break;
      }
      if (images.length >= limit) break;
    }
    res.json({ images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/world-settings/:id/cover — 上传星图卡片封面（base64 → 落盘 → 存短路径）
//
// 为什么走"落盘 + 存 URL"而不是把 base64 塞进 DB：
//   `listWorldSettings` 是星图首页每次打开都要调的接口，几十 KB 的 base64 会让列表膨胀；
//   而且换封面时能顺手删掉旧文件。
// 尺寸由前端先压到 ≤1600px / JPEG 0.85 —— 后端只做兜底校验（≤8MB 的 base64）。
router.post('/world-settings/:id/cover', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || !getWorldSettingById(id)) return res.status(404).json({ error: '世界不存在' });
  const base64 = req.body?.base64;
  if (!base64 || typeof base64 !== 'string') return res.status(400).json({ error: '缺少图片数据' });
  if (base64.length > 12 * 1024 * 1024) return res.status(400).json({ error: '图片过大，请先压缩再上传' });

  try {
    // 本文件没有模块级 __dirname（ESM）→ 就地算一次
    const here = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(here, '../..');
    const coversDir = path.join(projectRoot, 'data', 'world-covers');
    fs.mkdirSync(coversDir, { recursive: true });

    const m = /^data:image\/(\w+);base64,/.exec(base64);
    const ext = m && ['png', 'jpg', 'jpeg', 'webp'].includes(m[1].toLowerCase()) ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'jpg';
    const filename = `world_${id}_${Date.now()}.${ext}`;
    const payload = base64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(coversDir, filename), Buffer.from(payload, 'base64'));

    // 删旧文件（只删本目录下、本世界前缀的，别越界）
    const old = String(getWorldSettingById(id)?.cover_image || '');
    if (old) {
      const oldName = path.basename(old);
      if (oldName.startsWith(`world_${id}_`)) {
        try { fs.unlinkSync(path.join(coversDir, oldName)); } catch { /* 旧文件不在就算了 */ }
      }
    }

    const coverUrl = `/world-covers/${filename}`;
    updateWorldSetting(id, { cover_image: coverUrl });
    res.json({ ok: true, cover_image: coverUrl });
  } catch (err) {
    console.error('[world] cover upload failed:', err.message);
    res.status(500).json({ error: `封面上传失败：${err.message}` });
  }
});

// ── 星图封面：让 AI 按世界观画一张横幅 ───────────────────────
// 为什么要 LLM 先出提示词、再交给生图链路：
//   直接把世界观正文丢给生图模型，它只会画出「一堆抽象色块」——正文是设定说明，不是画面。
//   这里先让 LLM 把设定翻译成一段**纯视觉**的英文画面描述（地点/时间/天气/材质/光），
//   再原封不动送进 ComfyUI（alreadyPrepared:true 跳过后端二次改写，避免提示词被稀释）。
//
// 兜底：LLM 不可用（没配 key / 超时）时用规则拼装，封面功能不能因为 LLM 挂了就整块不可用。

/** 封面提示词的固定尾巴：压掉文字水印，并钉死"环境大景、不怼脸"的构图 */
const COVER_PROMPT_TAIL = 'no text, no watermark, no logo, no signature, no close-up face, '
  + 'wide establishing shot, scenery, cinematic lighting, highly detailed environment';

/** 把 LLM 输出清洗成单行提示词（去代码块/引号/前缀标签，压掉换行） */
function normalizeCoverPrompt(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  s = s.replace(/^[\s"'`]*(prompt|提示词)\s*[:：]/i, '');
  s = s.replace(/[\r\n]+/g, ', ').replace(/\s*,\s*(?:,\s*)+/g, ', ').replace(/\s{2,}/g, ' ');
  return s.replace(/^[,\s]+|[,\s]+$/g, '');
}

/** 规则兜底：不问 LLM，只用已有字段拼一段能看的画面描述 */
function fallbackCoverPrompt(world, extra) {
  const parts = [
    String(world.visual_tone || '').trim(),
    String(world.tagline || '').trim(),
    String(world.name || '').trim() ? `the world of ${String(world.name).trim()}` : '',
    extra,
  ].filter(Boolean);
  return normalizeCoverPrompt(parts.join(', '));
}

/**
 * 让 LLM 把世界观读成一段画面描述。
 * @returns {Promise<{ prompt: string, source: 'llm'|'fallback', note?: string }>}
 */
async function buildWorldCoverPrompt(world, extra) {
  const name = String(world.name || '').trim();
  const tagline = String(world.tagline || '').trim();
  const tone = String(world.visual_tone || '').trim();
  const content = String(world.content || '').trim().slice(0, 2600);

  const systemPrompt = `你是一名电影概念设计师。用户给你一份虚构世界的设定，你要写一段**用于 AI 绘图的英文画面描述**，画的是这个世界的"封面大景"。

【硬性要求】
- 只写**看得见的东西**：地点、时辰、天气、建筑与材质、光源、色调、镜头。不要写剧情、人物关系、设定解释、情感评价。
- **不要出现具体角色**，也不要写人脸特写；可以是空无一人的场景，远处可有极小的身影点缀。
- 输出必须是**一整段英文**，不要分行、不要编号、不要 Markdown、不要引号包裹、不要写 "Prompt:" 前缀。
- 长度 40～70 个英文单词，用逗号分隔的短语串联即可（例：a rain-soaked harbor at dusk, wooden piers, distant lighthouse, warm lantern glow, volumetric fog）。
- 时代与题材必须和设定一致：仙舟就是东方古典科幻，赛博都市就是霓虹钢铁，不要串味。
- **用户的补充要求若是否定句（"不要 X / 别 X / 去掉 X"），必须把 X 从画面里彻底剔除，用换掉景物的方式表达**——绝不能写成 "no X"。绘画模型对否定词几乎不服从，写了反而更容易画出 X。
- 画面里**不要出现任何文字、招牌字样、水印**。`;

  const userPrompt = [
    name ? `世界名称：${name}` : '',
    tagline ? `一句话简介：${tagline}` : '',
    tone ? `视觉基调（作者已指定，必须遵守）：${tone}` : '',
    content ? `世界观正文（只用来提取画面线索，不要照抄）：\n${content}` : '',
    extra ? `用户补充的画面要求（优先级最高）：${extra}` : '',
  ].filter(Boolean).join('\n\n');

  if (!content && !tone && !tagline && !extra) {
    return { prompt: '', source: 'fallback', note: '这个世界还没有任何内容，先在「世界观」页签写几句，AI 才知道该画什么' };
  }

  try {
    const msgs = [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
    const raw = await chatSync(msgs, {
      model: config.llm.model || 'deepseek-chat',
      temperature: 0.85,
      max_tokens: 320,
      // 320 是"一段画面描述"的正文预算，思考会把预算吃光 → 空返回（F-58/F-60/F-62 同构缺口）
      thinking: { type: 'disabled' },
      label: '世界封面提示词',
    });
    const prompt = normalizeCoverPrompt(raw);
    if (prompt && prompt.length >= 8) {
      return { prompt: `${prompt}, ${COVER_PROMPT_TAIL}`, source: 'llm' };
    }
    console.warn('[world] 封面提示词为空，改用规则拼装');
  } catch (err) {
    console.warn('[world] 封面提示词 LLM 失败，改用规则拼装:', err.message);
  }

  const fb = fallbackCoverPrompt(world, extra);
  if (!fb) return { prompt: '', source: 'fallback', note: '这个世界还没有任何内容，先在「世界观」页签写几句，AI 才知道该画什么' };
  return { prompt: `${fb}, ${COVER_PROMPT_TAIL}`, source: 'fallback' };
}

// POST /api/world-settings/:id/cover/generate — 按世界观生成封面（默认 1216×832）
//
// body: { extra?: string, dryRun?: boolean, stream?: boolean }
//   extra  —— 用户补充的画面要求（例如「想要雪夜」「不要霓虹」），优先级最高
//   dryRun —— 只出提示词不画图，用于先看提示词再决定（也方便命令行验证提示词质量）
//   stream —— true 走 SSE，逐段推 stage / prompt / progress / done，避免 60 秒干等
router.post('/world-settings/:id/cover/generate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const world = id ? getWorldSettingById(id) : null;
  if (!world) return res.status(404).json({ error: '世界不存在' });

  const extra = typeof req.body?.extra === 'string' ? req.body.extra.trim() : '';
  const dryRun = req.body?.dryRun === true;
  const streaming = req.body?.stream === true;

  const send = (event, data) => {
    if (streaming && !res.destroyed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  if (streaming) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }
  const finish = (payload, status = 200) => {
    if (streaming) { send('done', payload); res.end(); }
    else res.status(status).json(payload);
  };

  try {
    send('stage', { stage: 'prompting' });
    const { prompt, source, note } = await buildWorldCoverPrompt(world, extra);
    if (!prompt) {
      return streaming
        ? (send('error', { error: note || '这个世界还没有内容，AI 不知道画什么' }), res.end())
        : res.status(400).json({ error: note || '这个世界还没有内容，AI 不知道画什么' });
    }
    send('prompt', { prompt, source, note: note || '' });
    if (dryRun) return finish({ ok: true, dry_run: true, prompt, source });

    send('stage', { stage: 'generating' });
    // 尺寸固定 1216×832（用户指定）：SDXL 系的 19:13，横向横幅，正好铺星图卡片
    const result = await generateImage(prompt, {
      width: 1216,
      height: 832,
      scene: 'events',            // 借用"奇遇配图"的 LoRA 作用域：那是场景大图，最接近封面
      loras: [],                  // 不注入角色 LoRA —— 封面不该有某个角色的脸
      disableRAG: true,           // 不检索角色/记忆知识库，纯风景
      alreadyPrepared: true,      // 提示词已由上面的 LLM 写定，别再被二次改写
      promptScene: 'events',
      onProgress: (p) => { if (p?.stage) send('progress', { stage: p.stage, progress: p.progress ?? null }); },
    });

    if (!result?.success || !result.images?.length || !result.images[0]?.base64) {
      const msg = result?.error || '生图没有返回图片（ComfyUI 是否在运行？）';
      return streaming
        ? (send('error', { error: msg }), res.end())
        : res.status(500).json({ error: msg });
    }

    // 落盘：生成图在 ComfyUI 输出目录，会被清理；封面必须存进自己的目录
    const here = path.dirname(fileURLToPath(import.meta.url));
    const coversDir = path.join(path.resolve(here, '../..'), 'data', 'world-covers');
    fs.mkdirSync(coversDir, { recursive: true });
    const filename = `world_${id}_${Date.now()}.jpg`;
    // ★ ComfyUI 交上来的是 PNG（2MB 上下）。直接改后缀存成 .jpg 会让 Content-Type 与实际内容不符，
    //   体积也不适合当卡片背景 —— 真转一次 JPEG（1216×832 无损尺寸，只压画质）。
    // ★ 注意 images[].base64 其实是**完整 data URL**（`data:image/png;base64,...`，见 comfyClient.downloadImageAsBase64），
    //   不剥前缀直接 Buffer.from 会得到一堆解不出来的乱码（sharp 报 unsupported image format）。
    const rawB64 = String(result.images[0].base64).replace(/^data:image\/\w+;base64,/, '');
    const jpegBuf = await sharp(Buffer.from(rawB64, 'base64'))
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    fs.writeFileSync(path.join(coversDir, filename), jpegBuf);

    // 删旧封面（只删本世界前缀，不越界）
    const old = String(world.cover_image || '');
    if (old) {
      const oldName = path.basename(old);
      if (oldName.startsWith(`world_${id}_`)) {
        try { fs.unlinkSync(path.join(coversDir, oldName)); } catch { /* 旧文件不在就算了 */ }
      }
    }

    const coverUrl = `/world-covers/${filename}`;
    updateWorldSetting(id, { cover_image: coverUrl });
    console.log(`[world] 封面已生成 #${id} (${source}): ${filename}`);
    finish({ ok: true, cover_image: coverUrl, prompt, source });
  } catch (err) {
    console.error('[world] cover generate failed:', err.message);
    if (streaming) { send('error', { error: `封面生成失败：${err.message}` }); res.end(); }
    else res.status(500).json({ error: `封面生成失败：${err.message}` });
  }
});

// DELETE /api/world-settings/:id — 删除某个世界观
router.delete('/world-settings/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = deleteWorldSetting(id);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

// POST /api/world-settings/:id/activate — 切换激活某个世界观
router.post('/world-settings/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = activateWorldSetting(id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, item });
});

// GET /api/config/system-rules — 获取系统破限词（供世界观润色等 AI 功能请求体携带）
router.get('/system-rules', (_req, res) => {
  res.json({ content: getSystemRules({ roleplay: false }) || '' });
});

// ── 星图 T13：世界文本缓存观测量 ─────────────────────────────
// 为什么不静默缓存：缓存出错的形态是「改了世界但 prompt 没变」，很难肉眼发现。
// 这里把命中率、代数、最近几次失效原因摊开，排查时第一眼就能判断是"没失效"还是别的问题。
// 用法：连续聊几句后看 hits 涨不涨；改一次世界后看 recentInvalidations 有没有对应条目。
router.get('/world-cache-stats', (_req, res) => {
  res.json({ ok: true, ...getWorldCacheStats() });
});

// POST /api/world-settings/polish — AI 一键润色扩写世界观（酒馆世界书风格）
// 请求体带系统破限词：LLM 首条 system 消息注入破限词，保证扩写创作自由。
router.post('/world-settings/polish', async (req, res) => {
  const { name, content } = req.body || {};
  const source = typeof content === 'string' ? content.trim() : '';
  if (!source || source.length < 2) {
    return res.status(400).json({ error: '当前世界观内容为空，请先填写内容再润色' });
  }

  try {
    const model = config.llm.model || 'deepseek-chat';

    // 请求体（LLM messages）带上系统破限词：虚构文学定位 + 创作自由
    const jailbreak = (typeof req.body?.jailbreak === 'string' && req.body.jailbreak.trim())
      ? req.body.jailbreak.trim()
      : getSystemRules({ roleplay: false });

const systemPrompt = `你是一名资深的世界观设定师，擅长撰写「酒馆AI世界书（World Info / Lorebook）」风格的设定文本，服务于沉浸式角色扮演。

用户会提供一份世界观底稿。请忠于原意进行润色与扩写，写成一份简洁、自然、可直接用于角色扮演的世界书。

核心原则：
- 把底稿中最有冲击力的设定，当成这个世界**已经彻底内化**的绝对常识，不要写任何“怎么变成这样”的过程（禁止写改造、强制、适应期、带头示范等起源故事）。
- 重点写清两件事：1. 人们日常真正怎么做；2. 支撑这些行为的深层逻辑是什么。
- 整体语气要口语化、生活化，像在跟朋友随口介绍这个世界，自然随意，不要写成说明书，也不要有文学腔和修辞。
- 所有在常人看来私密或特殊的行为，必须处理得极其平淡自然，像喝水、上厕所、打哈欠一样普通，不要写成表演、炫耀或社交手段。
- 不要面面俱到，只抓住最能改变日常生活的核心点写透。

【输出结构要求】严格按以下 Markdown 分节顺序输出：

## 世界背景
- （用极短篇幅点明最核心的常识差异，不超过3行）

## 日常规则
- （写真正管着大家日常生活的规矩，用口语化的短句，直接说清楚平时该怎么做）

## 深层逻辑
- （用轻松自然的口吻解释，为什么在这个世界里这些事会变得这么理所当然。只讲现在的认知，不讲历史）

## 人们的行为
- （全篇重点。写 5-6 条典型行为。
  不要出现具体人名。
  用「在……的时候，大家通常会……」这种口语结构。
  每条只写一个主要动作，怎么处理就怎么写，别加多余的描写和铺垫。
  涉及私密行为时，必须写得冷静、随意，不要出现故意展示、围观起哄、提升人气这类内容。）

【写作要求】
- 保留原文专有名词与核心设定，不得弱化或道德化原设定；
- 语言口语化、自然，避免书面腔、说明书腔和文学修辞；
- 全文控制在 700～1200 字；
- 只输出设定正文，不要任何解释、前后缀或代码块；
- 使用简体中文。`;

    const userPrompt = [
      typeof name === 'string' && name.trim() ? `世界名称：${name.trim()}（仅作题材与基调参考，正文不要输出名称标题）` : '',
      `原始世界观：\n${source}`,
    ].filter(Boolean).join('\n\n');

    const msgs = [];
    if (jailbreak) msgs.push({ role: 'system', content: jailbreak });
    msgs.push({ role: 'system', content: systemPrompt });
    msgs.push({ role: 'user', content: userPrompt });

    const result = await chatSync(msgs, { model, temperature: 0.7, max_tokens: 4096, label: '世界观润色' });

    // 防御：剥离可能包裹输出的 Markdown 代码块
    let polished = (result || '').trim();
    const fence = polished.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
    if (fence) polished = fence[1].trim();
    if (!polished) {
      return res.status(500).json({ error: 'AI 生成结果为空，请重试' });
    }
    res.json({ ok: true, content: polished });
  } catch (err) {
    console.error('[world-settings] polish failed:', err.message);
    res.status(500).json({ error: '润色失败: ' + err.message });
  }
});
// PUT /api/config/weather-city — 设置天气城市
router.put('/weather-city', (req, res) => {
  const { city } = req.body;
  if (typeof city !== 'string') {
    return res.status(400).json({ error: 'city must be a string' });
  }
  updateWeatherConfig(city);
  res.json({ ok: true, city: config.weather.city });
});

export default router;
