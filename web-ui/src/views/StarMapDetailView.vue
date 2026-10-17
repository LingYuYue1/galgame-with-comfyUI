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
          <!-- ★ 星图 T15：在途的人不给"前往"（一段没走完不能再起一段），显示倒计时 -->
          <span v-if="transitOf(c.id)" class="smd-transit-badge">在途 · 还需 {{ remainText(transitOf(c.id)) }}</span>
          <linshe-button
            v-else
            variant="ghost"
            size="sm"
            class="smd-row-act"
            title="发起一段跨世界旅程（路上要花时间）"
            @click="openTrip(c)"
          >前往…</linshe-button>
          <linshe-button
            variant="ghost"
            size="sm"
            class="smd-row-act"
            :disabled="!!transitOf(c.id)"
            :title="transitOf(c.id) ? '她正在路上，等到了再改归属' : ''"
            @click="removeFromWorld(c)"
          >移出</linshe-button>
        </div>
      </div>

      <!-- ★ 星图 T10：把角色放进这个世界（不指定 = 跟随激活世界） -->
      <div class="smd-add-row">
        <linshe-select
          v-model="pickCharId"
          class="smd-add-select"
          :options="candidateOptions"
          placeholder="选择一个还没归属这个世界的角色"
        />
        <linshe-button
          variant="secondary"
          size="sm"
          :disabled="pickCharId === '' || busyChar"
          :loading="busyChar"
          @click="addToWorld"
        >放进这个世界</linshe-button>
      </div>
      <p class="smd-hint smd-hint-foot">
        也可以点「聊天」左侧的角色卡，在「所在世界」里改；不指定时跟随激活世界。
      </p>
    </section>

    <section v-else-if="tab === 'trip'" class="smd-body">
      <div v-if="!transitTrips.length && !historyTrips.length" class="smd-placeholder">
        <p class="smd-placeholder-title">旅程还没有开启</p>
        <p class="smd-placeholder-sub">在「角色」页签点「前往…」，让她花点时间走过去 —— 角色不会一瞬间到达。</p>
      </div>

      <template v-else>
        <div v-if="transitTrips.length" class="smd-trip-list">
          <div v-for="t in transitTrips" :key="t.id" class="smd-trip-card">
            <div class="smd-trip-top">
              <span class="smd-trip-who">{{ charName(t.character_id) }}</span>
              <span class="smd-trip-route">{{ worldName(t.from_world_id) || '未指定' }} → {{ worldName(t.to_world_id) }}</span>
            </div>
            <div class="smd-trip-bottom">
              <span class="smd-trip-meta">{{ t.transport_label }} · 还需 {{ remainText(t) }}</span>
              <linshe-button variant="ghost" size="sm" @click="cancelTrip(t)">取消这一段</linshe-button>
            </div>
            <p v-if="t.note" class="smd-trip-note">{{ t.note }}</p>
          </div>
        </div>

        <div v-if="historyTrips.length" class="smd-trip-history">
          <p class="smd-trip-history-title">历史旅程</p>
          <div v-for="t in historyTrips" :key="'h' + t.id" class="smd-trip-hist-row">
            <span class="smd-trip-hist-who">{{ charName(t.character_id) }}</span>
            <span class="smd-trip-hist-route">{{ worldName(t.from_world_id) || '未指定' }} → {{ worldName(t.to_world_id) }}</span>
            <span class="smd-trip-hist-state" :class="{ 'is-cancelled': t.status === 'cancelled' }">
              {{ t.status === 'arrived' ? '已抵达' : '已取消' }}
            </span>
          </div>
        </div>
      </template>
    </section>

    <linshe-modal v-model="renameOpen" title="重命名世界">
      <linshe-input v-model="renameValue" placeholder="世界名" @keyup.enter="confirmRename" />
      <template #footer>
        <linshe-button variant="secondary" @click="renameOpen = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="!renameValue.trim()" @click="confirmRename">保存</linshe-button>
      </template>
    </linshe-modal>

    <!-- ★ 星图 T15：发起跨世界旅程 -->
    <linshe-modal v-model="tripOpen" title="前往别的世界">
      <div class="smd-trip-form">
        <div class="smd-trip-who-row">
          <span class="smd-avatar">{{ (tripCharName || '?').slice(0, 1) }}</span>
          <span class="smd-trip-who-name">{{ tripCharName }}</span>
          <span class="smd-trip-who-from">从 {{ world?.name || '当前世界' }} 出发</span>
        </div>
        <label class="smd-field">
          <span class="smd-field-label">目的地</span>
          <linshe-select
            v-model="tripToWorldId"
            :options="tripDestOptions"
            placeholder="选一个世界"
          />
        </label>
        <label class="smd-field">
          <span class="smd-field-label">交通方式</span>
          <linshe-select v-model="tripTransport" :options="transportOptions" />
        </label>
        <label class="smd-field">
          <span class="smd-field-label">路上带一句<span class="smd-optional">（可选，会写进她的旅途语境）</span></span>
          <linshe-input v-model="tripNote" placeholder="例如：她带了一只旧行李箱，一路上没怎么说话" />
        </label>
        <p class="smd-trip-cost">
          路上要花 <strong>{{ tripDurationHours }}</strong> 小时。这段时间她的世界观语境是「旅途本身」，
          日程排成赶路，到点自动落在目的地。
        </p>
      </div>
      <template #footer>
        <linshe-button variant="secondary" @click="tripOpen = false">再想想</linshe-button>
        <linshe-button
          variant="primary"
          :disabled="tripToWorldId === '' || tripBusy"
          :loading="tripBusy"
          @click="startTrip"
        >出发</linshe-button>
      </template>
    </linshe-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api/index.js'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import LinsheTabs from '../components/ui/LinsheTabs.vue'
import LinsheSwitch from '../components/ui/LinsheSwitch.vue'
import LinsheSelect from '../components/ui/LinsheSelect.vue'
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
// ★ 星图 T10：全部角色（用于「把角色放进这个世界」的候选）；pickCharId 用空串表示未选
const allChars = ref([])
const pickCharId = ref('')
const busyChar = ref(false)
const renameOpen = ref(false)
const renameValue = ref('')

// ★ 星图 T15：旅程
const worlds = ref([])            // 全部世界（目的地候选 + 世界名反查）
const trips = ref([])             // 本世界相关的旅程（出发地或目的地命中）
const tripsFetchedAt = ref(Date.now()) // 倒计时基准：列表拉取时刻
const nowTick = ref(Date.now())   // 每 30s 跳一次，驱动倒计时刷新
const tripConfig = ref(null)
const tripOpen = ref(false)
const tripCharId = ref(null)
const tripToWorldId = ref('')
const tripTransport = ref('train')
const tripNote = ref('')
const tripBusy = ref(false)
let tickTimer = null

const tripDurationHours = computed(() => tripConfig.value?.duration_hours ?? 6)

const transportOptions = computed(() =>
  (tripConfig.value?.transports || []).map((t) => ({ label: t.label, value: t.value }))
)

const tripCharName = computed(() => {
  const c = allChars.value.find((x) => Number(x.id) === Number(tripCharId.value))
  return c?.display_name || c?.name || ''
})

// 目的地候选：排除当前世界（去了等于没去，后端也会拦）
const tripDestOptions = computed(() =>
  worlds.value
    .filter((w) => Number(w.id) !== worldId.value)
    .map((w) => ({
      label: `${w.name}${w.is_active ? ' · 激活' : (w.is_enabled ? '' : ' · 休眠')}`,
      value: w.id,
    }))
)

const transitTrips = computed(() => trips.value.filter((t) => t.status === 'transit'))
const historyTrips = computed(() =>
  trips.value.filter((t) => t.status !== 'transit').slice(0, 20)
)

/** 角色 id → 在途那一段（没在途 → undefined） */
const transitByChar = computed(() => {
  const map = {}
  for (const t of transitTrips.value) map[Number(t.character_id)] = t
  return map
})

function transitOf(characterId) {
  return transitByChar.value[Number(characterId)]
}

function worldName(id) {
  if (id == null) return ''
  return worlds.value.find((w) => Number(w.id) === Number(id))?.name || `#${id}`
}

function charName(id) {
  const c = allChars.value.find((x) => Number(x.id) === Number(id))
  return c?.display_name || c?.name || `角色 #${id}`
}

/**
 * 剩余时间文案。后端给的是「拉取那一刻的剩余分钟」，这里按流逝时间扣减，
 * 否则页面开着一小时，倒计时会一直停在 5 小时。
 */
function remainText(trip) {
  if (!trip) return ''
  const elapsed = (nowTick.value - tripsFetchedAt.value) / 60000
  const m = Math.max(0, Math.round(Number(trip.remaining_minutes || 0) - elapsed))
  if (m <= 0) return '即将抵达'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r >= 5 ? `${h} 小时 ${r} 分` : `${h} 小时`
}

async function loadTrips() {
  try {
    const r = await api.listTrips({ world_id: worldId.value, limit: 50 })
    trips.value = r?.items || []
    tripsFetchedAt.value = Date.now()
  } catch { /* 旅程读取失败不阻断页面（后端未重启时新接口会 404） */ }
}

function openTrip(c) {
  tripCharId.value = c.id
  tripToWorldId.value = ''
  tripTransport.value = 'train'
  tripNote.value = ''
  tripOpen.value = true
}

async function startTrip() {
  if (tripBusy.value || tripToWorldId.value === '') return
  tripBusy.value = true
  try {
    await api.createTrip({
      character_id: Number(tripCharId.value),
      to_world_id: Number(tripToWorldId.value),
      transport: tripTransport.value,
      note: tripNote.value.trim() || undefined,
    })
    tripOpen.value = false
    await loadTrips()
    tab.value = 'trip'
    toastFn?.(`出发了 —— 路上要 ${tripDurationHours.value} 小时`, 'success')
  } catch (err) {
    toastFn?.('出发失败：' + (err?.message || ''), 'error')
  } finally {
    tripBusy.value = false
  }
}

async function cancelTrip(t) {
  try {
    await api.cancelTrip(t.id)
    await loadTrips()
    toastFn?.('已取消这一段，她留在原地', 'success')
  } catch (err) {
    toastFn?.('取消失败：' + (err?.message || ''), 'error')
  }
}

async function load() {
  try {
    const r = await api.getWorldSettings()
    const list = Array.isArray(r) ? r : (r?.list || [])
    worlds.value = list
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
    allChars.value = all
    chars.value = all.filter((c) => Number(c.world_setting_id) === worldId.value)
  } catch { /* 角色读取失败不阻断页面 */ }
  // ★ 星图 T15：旅程配置 + 本世界的旅程列表
  try { tripConfig.value = await api.getTripConfig() } catch { /* 老后端没有这个接口 → 用默认 6 */ }
  await loadTrips()
}

// ★ 星图 T10：候选 = 还没归属本世界的角色（含"不指定"的）
const candidateOptions = computed(() =>
  allChars.value
    .filter((c) => Number(c.world_setting_id) !== worldId.value)
    .map((c) => ({
      label: (c.display_name || c.name || `#${c.id}`) + (c.world_setting_id ? ' · 现在别的世界' : ' · 未指定'),
      value: c.id,
    }))
)

async function bindCharacter(id, targetWorldId) {
  if (busyChar.value) return
  busyChar.value = true
  try {
    await api.updateCharacter(id, { world_setting_id: targetWorldId })
    await load()
    pickCharId.value = ''
    toastFn?.(targetWorldId ? '已放进这个世界' : '已移出（跟随激活世界）', 'success')
  } catch (err) {
    toastFn?.('改绑失败：' + (err?.message || ''), 'error')
  } finally {
    busyChar.value = false
  }
}

function addToWorld() {
  if (pickCharId.value === '') return
  return bindCharacter(Number(pickCharId.value), worldId.value)
}

function removeFromWorld(c) {
  return bindCharacter(c.id, null)
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
  // ★ 星图 T12：引用保护（后端同样会拦，这里先给出更好懂的提示）
  const charCount = world.value?.characterCount || 0
  if (charCount > 0) {
    toastFn?.(`这个世界还有 ${charCount} 个角色归属，先给角色改绑世界（或改为「不指定」）再删`, 'error')
    return
  }
  const mapCount = world.value?.mapCount || 0
  if (mapCount > 0) {
    toastFn?.(`这个世界还有 ${mapCount} 张地图，先把地图改挂到别的世界再删`, 'error')
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
// ★ 星图 T15：倒计时每 30s 跳一次；顺带在切到这个页面时重拉一次旅程（可能在别处发起了）
onMounted(() => {
  tickTimer = setInterval(() => { nowTick.value = Date.now() }, 30000)
})
onUnmounted(() => {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
})
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
.smd-paper :deep(.ls-input::placeholder) { color: #786a5e; }

.smd-textarea { width: 100%; }
.smd-paper-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
}
/* 亮纸上的强调小字：#ae6451 实测 3.95 → 压到 #8f4a38 得 5.84 */
.smd-dirty { font-size: 12px; color: #8f4a38; margin-right: auto; }

.smd-fields { display: flex; flex-direction: column; gap: 12px; }
.smd-field { display: flex; flex-direction: column; gap: 6px; }
.smd-field-label { font-size: 13px; color: var(--text-secondary); }
.smd-optional { font-size: 11px; color: var(--text-secondary); }

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
/* ★ 星图 T10：角色页签的「放进这个世界」一行 + 行内「移出」按钮 */
.smd-row-act { flex: none; margin-left: 8px; }
.smd-add-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.smd-add-select { flex: 1 1 220px; min-width: 0; }
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

/* ── ★ 星图 T15：旅程 ─────────────────────────────────────
   全部走主题变量（不写死色值）：暗夜档自动翻转，亮色档沿用 --text-*。
   在途卡片是"这一页唯一有重量"的东西 → 用 --bg-secondary + 左侧强调条，
   不套卡片套卡片，也不加玻璃/光斑。 */
.smd-transit-badge {
  margin-left: auto;
  flex: none;
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--bg-tertiary, var(--bg-secondary));
  border: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
}

.smd-trip-list { display: flex; flex-direction: column; gap: 10px; }
.smd-trip-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
}
.smd-trip-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.smd-trip-who { font-size: 13.5px; color: var(--text-primary); }
.smd-trip-route { font-size: 12.5px; color: var(--text-secondary); }
.smd-trip-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
.smd-trip-meta { font-size: 12.5px; color: var(--text-secondary); }
.smd-trip-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.smd-trip-history { display: flex; flex-direction: column; gap: 4px; padding-top: 4px; }
.smd-trip-history-title {
  margin: 0 0 2px;
  font-size: 12px;
  color: var(--text-secondary);
}
.smd-trip-hist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--text-secondary);
}
.smd-trip-hist-row:nth-child(odd) { background: var(--bg-secondary); }
.smd-trip-hist-who { color: var(--text-primary); flex: none; }
.smd-trip-hist-route { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smd-trip-hist-state { flex: none; font-size: 11.5px; }
.smd-trip-hist-state.is-cancelled { color: var(--text-secondary); }

/* 发起旅程弹窗 */
.smd-trip-form { display: flex; flex-direction: column; gap: 12px; }
.smd-trip-who-row { display: flex; align-items: center; gap: 8px; }
.smd-trip-who-name { font-size: 13.5px; color: var(--text-primary); }
.smd-trip-who-from { margin-left: auto; font-size: 12px; color: var(--text-secondary); }
.smd-trip-cost {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.smd-trip-cost strong { color: var(--text-primary); font-weight: 600; }

@media (max-width: 560px) {
  .smd-page { padding: 12px 12px 40px; }
  .smd-head-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
  .smd-trip-bottom { flex-wrap: wrap; }
  .smd-transit-badge { margin-left: 0; }
}
</style>
