<template>
  <div class="page smd-page">
    <header class="smd-head">
      <button type="button" class="smd-back" @click="router.push('/starmap')">← 星图</button>
      <div class="smd-title-wrap">
        <h1 class="smd-title">{{ world?.name || '世界' }}</h1>
        <span v-if="world?.is_active" class="smd-badge">激活</span>
      </div>
      <div class="smd-head-actions">
        <linshe-button
          v-if="world && !world.is_active"
          variant="secondary"
          size="sm"
          title="激活后，聊天与日程按这个世界观解析"
          @click="makeActive"
        >设为激活</linshe-button>
        <linshe-switch
          v-if="world"
          :model-value="!!world.is_enabled"
          size="sm"
          title="世界开关：休眠后不参与媒体抽卡与后台任务"
          @change="saveEnabled"
        />
        <linshe-button variant="ghost" size="sm" @click="openRename">重命名</linshe-button>
        <linshe-button variant="danger" size="sm" @click="removeWorld">删除</linshe-button>
      </div>
    </header>

    <linshe-tabs
      v-model="tab"
      class="smd-tabs"
      :options="[
        { label: '世界观', value: 'world' },
        { label: '地图', value: 'map' },
        { label: '角色', value: 'char' },
        { label: '旅程', value: 'trip' },
      ]"
    />

    <section v-if="tab === 'world'" class="smd-body">
      <div class="smd-paper">
        <linshe-input
          v-model="content"
          type="textarea"
          :rows="16"
          class="smd-textarea"
          placeholder="写下这个世界的模样……"
          @update:modelValue="dirty = true"
        />
        <div class="smd-paper-foot">
          <span v-if="dirty" class="smd-dirty">有未保存的改动</span>
          <linshe-button
            variant="secondary"
            size="sm"
            :disabled="polishing || !content.trim()"
            :loading="polishing"
            @click="polish"
          >一键润色</linshe-button>
          <linshe-button
            variant="primary"
            size="sm"
            :disabled="!dirty || saving"
            :loading="saving"
            @click="saveWorld"
          >保存</linshe-button>
        </div>
      </div>

      <div class="smd-fields">
        <label class="smd-field">
          <span class="smd-field-label">一句话简介<span class="smd-optional">（星图卡片上的一句话）</span></span>
          <linshe-input v-model="tagline" placeholder="一句话说清这个世界的样子" @blur="saveMeta" />
        </label>
        <label class="smd-field">
          <span class="smd-field-label">视觉基调<span class="smd-optional">（≤60 字，会拼入生图环境）</span></span>
          <linshe-input v-model="visualTone" maxlength="60" placeholder="色调、光线、材质…例如：湿冷的青灰石巷，暖黄灯火" @blur="saveMeta" />
        </label>
      </div>
    </section>

    <section v-else-if="tab === 'map'" class="smd-body">
      <div class="smd-list">
        <div v-if="!maps.length" class="smd-hint">这个世界还没有地图。</div>
        <div v-for="m in maps" :key="m.id" class="smd-row">
          <span class="smd-row-name">{{ m.name }}</span>
          <span class="smd-row-meta">{{ m.place_count || 0 }} 个地点</span>
        </div>
      </div>
      <div class="smd-foot-actions">
        <linshe-button variant="secondary" size="sm" @click="router.push('/worldmap')">去地图页建图</linshe-button>
      </div>
    </section>

    <section v-else-if="tab === 'char'" class="smd-body">
      <div class="smd-list">
        <div v-if="!chars.length" class="smd-hint">还没有角色归属这个世界。</div>
        <div v-for="c in chars" :key="c.id" class="smd-row">
          <span class="smd-avatar">{{ (c.display_name || c.name || '?').slice(0, 1) }}</span>
          <span class="smd-row-name">{{ c.display_name || c.name }}</span>
          <span class="smd-row-meta">旅程随后开放</span>
        </div>
      </div>
      <p class="smd-hint smd-hint-foot">角色的世界归属在「角色详情 → 所在世界」里修改（T10 开放）。</p>
    </section>

    <section v-else class="smd-body">
      <div class="smd-placeholder">
        <p class="smd-placeholder-title">旅程还没有开启</p>
        <p class="smd-placeholder-sub">跨世界旅行（在途时间 + 日程联动）将在后续版本落地。</p>
      </div>
    </section>

    <linshe-modal v-model="renameOpen" title="重命名世界">
      <linshe-input v-model="renameValue" placeholder="世界名" @keyup.enter="confirmRename" />
      <template #footer>
        <linshe-button variant="secondary" @click="renameOpen = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="!renameValue.trim()" @click="confirmRename">保存</linshe-button>
      </template>
    </linshe-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api/index.js'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import LinsheTabs from '../components/ui/LinsheTabs.vue'
import LinsheSwitch from '../components/ui/LinsheSwitch.vue'
import LinsheModal from '../components/ui/LinsheModal.vue'

const route = useRoute()
const router = useRouter()
const toastFn = inject('toast')

const worldId = computed(() => Number(route.params.id))
const world = ref(null)
const content = ref('')
const tagline = ref('')
const visualTone = ref('')
const dirty = ref(false)
const saving = ref(false)
const polishing = ref(false)
const activating = ref(false)
const tab = ref('world')
const maps = ref([])
const chars = ref([])
const renameOpen = ref(false)
const renameValue = ref('')

async function load() {
  try {
    const r = await api.getWorldSettings()
    const list = Array.isArray(r) ? r : (r?.list || [])
    world.value = list.find((w) => w.id === worldId.value) || null
    if (!world.value) {
      toastFn?.('世界不存在', 'error')
      router.replace('/starmap')
      return
    }
    content.value = world.value.content || ''
    tagline.value = world.value.tagline || ''
    visualTone.value = world.value.visual_tone || ''
    dirty.value = false
  } catch (err) {
    toastFn?.('读取失败：' + (err?.message || ''), 'error')
  }
  try {
    const mr = await api.listWorldMaps()
    const all = mr?.maps || []
    maps.value = all.filter((m) => Number(m.world_setting_id) === worldId.value)
  } catch { /* 地图读取失败不阻断页面 */ }
  try {
    const cr = await api.listCharacters()
    const all = Array.isArray(cr) ? cr : (cr?.characters || cr?.list || [])
    chars.value = all.filter((c) => Number(c.world_setting_id) === worldId.value)
  } catch { /* 角色读取失败不阻断页面 */ }
}

async function saveWorld() {
  if (saving.value) return
  saving.value = true
  try {
    await api.updateWorldSetting(worldId.value, {
      content: content.value,
      tagline: tagline.value,
      visual_tone: visualTone.value,
    })
    dirty.value = false
    toastFn?.('已保存', 'success')
  } catch (err) {
    toastFn?.('保存失败：' + (err?.message || ''), 'error')
  } finally {
    saving.value = false
  }
}

async function saveMeta() {
  try {
    await api.updateWorldSetting(worldId.value, {
      tagline: tagline.value,
      visual_tone: visualTone.value,
    })
  } catch (err) {
    toastFn?.('保存失败：' + (err?.message || ''), 'error')
  }
}

async function makeActive() {
  if (activating.value) return
  activating.value = true
  try {
    await api.activateWorldSetting(worldId.value)
    await load()
    toastFn?.('已激活这个世界', 'success')
  } catch (err) {
    toastFn?.('激活失败：' + (err?.message || ''), 'error')
  } finally {
    activating.value = false
  }
}

async function saveEnabled(val) {
  try {
    await api.updateWorldSetting(worldId.value, { is_enabled: !!val })
    if (world.value) world.value.is_enabled = val ? 1 : 0
    toastFn?.(val ? '世界已启用' : '世界已休眠', 'success')
  } catch (err) {
    toastFn?.('开关保存失败：' + (err?.message || ''), 'error')
  }
}

async function polish() {
  if (polishing.value) return
  polishing.value = true
  try {
    let jailbreak = ''
    try {
      const rules = await api.getSystemRules()
      jailbreak = rules?.content || ''
    } catch { /* 取不到破限词就不带 */ }
    const result = await api.polishWorldSetting({
      name: world.value?.name || '',
      content: content.value,
      jailbreak,
    })
    if (!result?.ok || !result.content) throw new Error(result?.error || '润色失败')
    content.value = result.content
    dirty.value = true
    toastFn?.('润色完成，记得保存', 'success')
  } catch (err) {
    toastFn?.('润色失败：' + (err?.message || ''), 'error')
  } finally {
    polishing.value = false
  }
}

function openRename() {
  renameValue.value = world.value?.name || ''
  renameOpen.value = true
}

async function confirmRename() {
  const v = renameValue.value.trim()
  if (!v) return
  try {
    await api.updateWorldSetting(worldId.value, { name: v })
    if (world.value) world.value.name = v
    renameOpen.value = false
    toastFn?.('已重命名', 'success')
  } catch (err) {
    toastFn?.('重命名失败：' + (err?.message || ''), 'error')
  }
}

async function removeWorld() {
  const count = world.value?.characterCount || 0
  if (count > 0) {
    toastFn?.(`这个世界还有 ${count} 个角色归属，先给角色改绑世界再删`, 'error')
    return
  }
  if (!window.confirm(`删除世界「${world.value?.name}」？世界观正文会一并删除（项目库会归档保留）。`)) return
  try {
    await api.deleteWorldSetting(worldId.value)
    toastFn?.('世界已删除', 'success')
    router.replace('/starmap')
  } catch (err) {
    toastFn?.('删除失败：' + (err?.message || ''), 'error')
  }
}

onMounted(load)
</script>

<style scoped>
.smd-page {
  max-width: 980px;
  margin: 0 auto;
  padding: 18px 20px 48px;
  box-sizing: border-box;
}
.smd-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.smd-back {
  border: none;
  background: none;
  padding: 4px 2px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.smd-back:hover { color: var(--accent); }
.smd-title-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
.smd-title {
  font-size: 20px;
  font-weight: 500;
  margin: 0;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.smd-badge {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 999px;
  background: var(--accent-solid);
  color: #fff;
}
.smd-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.smd-tabs { margin-bottom: 14px; }

.smd-body { display: flex; flex-direction: column; gap: 14px; }

.smd-paper {
  background: #f4f1ee;
  color: #554a43;
  border: 1.5px solid #cbb599;
  border-radius: 16px;
  padding: 14px;
  box-shadow: 0 2px 0 rgba(53, 42, 35, 0.08);
}
/* 纸内输入框跟随纸色 —— 不在暖纸上再套一个白框（避免"卡片套卡片"的观感） */
.smd-paper :deep(.ls-input) {
  background: #fbf8f4;
  border-color: #d8c7b0;
  color: #4a3f38;
  --ls-input-focus-color: #ae6451;
}
.smd-paper :deep(.ls-input::placeholder) { color: #9b8c80; }

.smd-textarea { width: 100%; }
.smd-paper-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
}
.smd-dirty { font-size: 12px; color: #ae6451; margin-right: auto; }

.smd-fields { display: flex; flex-direction: column; gap: 12px; }
.smd-field { display: flex; flex-direction: column; gap: 6px; }
.smd-field-label { font-size: 13px; color: var(--text-secondary); }
.smd-optional { font-size: 11px; color: var(--text-tertiary); }

.smd-list { display: flex; flex-direction: column; gap: 8px; }
.smd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}
.smd-row-name { font-size: 13.5px; color: var(--text-primary); }
.smd-row-meta { margin-left: auto; font-size: 12px; color: var(--text-secondary); }
.smd-avatar {
  width: 26px; height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  background: #e6dccd;
  color: #554a43;
  flex: none;
}
.smd-hint { font-size: 12.5px; color: var(--text-secondary); padding: 8px 2px; }
.smd-hint-foot { padding-top: 2px; }
.smd-foot-actions { display: flex; justify-content: flex-end; }

.smd-placeholder {
  text-align: center;
  padding: 56px 16px;
  background: var(--bg-secondary);
  border: 1.5px dashed var(--border-strong);
  border-radius: 18px;
}
.smd-placeholder-title { margin: 0 0 6px; font-size: 15px; color: var(--text-primary); }
.smd-placeholder-sub { margin: 0; font-size: 12.5px; color: var(--text-secondary); }

@media (max-width: 560px) {
  .smd-page { padding: 12px 12px 40px; }
  .smd-head-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
}
</style>
