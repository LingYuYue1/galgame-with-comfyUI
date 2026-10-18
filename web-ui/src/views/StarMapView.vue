<template>
  <div class="page sm-page" :class="{ 'is-detail': !!selectedId }">
    <!-- ★ 2026-10-18 用户改主意：卡片墙 → 左侧列表 + 右侧详情。
         桌面端两栏常驻；窄屏退化成「列表 ↔ 详情」两态（点进世界才出详情，顶部给返回）。 -->
    <div class="sm-layout" :class="{ 'is-detail': !!selectedId }">
      <aside class="sm-side">
        <header class="sm-side-head">
          <h1 class="sm-title">星图</h1>
          <span class="sm-count">{{ worlds.length }} 个世界</span>
        </header>

        <div v-if="loading" class="sm-side-hint">正在展开星图…</div>

        <div v-else class="sm-side-list">
          <button
            v-for="w in worlds"
            :key="w.id"
            type="button"
            class="sm-item"
            :class="{ 'is-active': w.id === selectedId, 'is-off': !w.is_enabled }"
            @click="select(w)"
          >
            <span
              class="sm-item-thumb"
              :class="{ 'has-cover': !!w.cover_image }"
              :style="w.cover_image
                ? { backgroundImage: `url(${w.cover_image})` }
                : { background: dotColor(w.id) }"
            ><b v-if="!w.cover_image">{{ initialOf(w) }}</b></span>
            <span class="sm-item-main">
              <span class="sm-item-name">
                {{ w.name }}
                <em v-if="w.is_active" class="sm-pin">激活</em>
              </span>
              <span class="sm-item-sub">{{ w.tagline || '还没有一句话简介' }}</span>
            </span>
            <span class="sm-item-meta">{{ w.characterCount || 0 }} 角色 · {{ w.mapCount || 0 }} 地图</span>
          </button>

          <button type="button" class="sm-item sm-item-add" @click="openCreate">
            <span class="sm-add-plus">+</span>
            <span class="sm-item-main"><span class="sm-item-name">新建世界</span></span>
          </button>
        </div>

        <p v-if="!loading && !worlds.length" class="sm-side-hint">
          星图还是一片空白，先建第一个世界。
        </p>
      </aside>

      <main class="sm-main">
        <template v-if="selectedId">
          <button type="button" class="sm-mobile-back" @click="router.push('/starmap')">← 星图</button>
          <StarMapDetailView
            embedded
            :world-id="selectedId"
            @changed="loadWorlds"
            @removed="onWorldRemoved"
          />
        </template>
        <div v-else class="sm-placeholder">
          <p class="sm-placeholder-title">选一个世界</p>
          <p class="sm-placeholder-sub">左边点开任意世界，右边就是它的世界观、地图、角色和旅程。</p>
        </div>
      </main>
    </div>

    <linshe-modal v-model="createOpen" title="新建世界">
      <div class="sm-form">
        <label class="sm-field">
          <span class="sm-field-label">世界名</span>
          <linshe-input v-model="newName" placeholder="给这个世界起个名字…" @keyup.enter="confirmCreate" />
        </label>
        <label class="sm-field">
          <span class="sm-field-label">一句话简介<span class="sm-optional">（可后改）</span></span>
          <linshe-input v-model="newTagline" placeholder="例如：一座终年落雨的海港城" @keyup.enter="confirmCreate" />
        </label>
      </div>
      <template #footer>
        <linshe-button variant="secondary" @click="createOpen = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="!newName.trim() || busy" :loading="busy" @click="confirmCreate">创建</linshe-button>
      </template>
    </linshe-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { inject } from 'vue'
import * as api from '../api/index.js'
import StarMapDetailView from './StarMapDetailView.vue'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import LinsheModal from '../components/ui/LinsheModal.vue'

const route = useRoute()
const router = useRouter()
const toastFn = inject('toast')

const worlds = ref([])
const loading = ref(true)
const createOpen = ref(false)
const newName = ref('')
const newTagline = ref('')
const busy = ref(false)

/** 当前选中的世界来自路由 —— 左栏点击 = 换路由，详情组件因此不会被重挂载 */
const selectedId = computed(() => Number(route.params.id) || null)

const DOT_COLORS = [
  'var(--fun-purple)', 'var(--fun-pink)', 'var(--fun-orange)', 'var(--fun-teal)',
  'var(--fun-blue)', 'var(--fun-gold)', 'var(--fun-violet)',
]
const dotColor = (id) => DOT_COLORS[Math.abs(Number(id) || 0) % DOT_COLORS.length]
const initialOf = (w) => String(w.name || '?').trim().slice(0, 1) || '?'

async function loadWorlds() {
  try {
    const r = await api.getWorldSettings()
    worlds.value = Array.isArray(r) ? r : (r?.list || [])
  } catch (err) {
    toastFn?.('星图读取失败：' + (err?.message || ''), 'error')
  } finally {
    loading.value = false
  }
}

function select(w) {
  if (Number(w.id) === selectedId.value) return
  router.push('/starmap/' + w.id)
}

/** 详情页删掉世界后：回到空态（详情自己通知过了，这里只负责收口） */
function onWorldRemoved() {
  loadWorlds()
  router.replace('/starmap')
}

function openCreate() {
  newName.value = ''
  newTagline.value = ''
  createOpen.value = true
}

async function confirmCreate() {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  try {
    const r = await api.createWorldSetting({ name, tagline: newTagline.value.trim() })
    createOpen.value = false
    const id = r?.item?.id
    toastFn?.('世界已创建，去填世界观吧', 'success')
    await loadWorlds()
    if (id) router.replace('/starmap/' + id)
  } catch (err) {
    toastFn?.('创建失败：' + (err?.message || ''), 'error')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadWorlds()
  // 桌面端：没指定世界就自动选第一个 —— 否则右半边空着，像加载失败
  // 窄屏：保持列表态，别把用户直接弹进详情
  const narrow = window.matchMedia('(max-width: 900px)').matches
  if (!selectedId.value && !narrow && worlds.value.length) {
    router.replace('/starmap/' + worlds.value[0].id)
  }
})
</script>

<style scoped>
.sm-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 20px 20px 48px;
  box-sizing: border-box;
}
.sm-layout {
  display: grid;
  grid-template-columns: 296px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

/* ── 左栏：世界列表 ───────────────────────────────────── */
.sm-side {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.sm-side-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px; }
.sm-title { font-size: 20px; font-weight: 500; margin: 0; color: var(--text-bright); }
.sm-count { font-size: 12px; color: var(--text-secondary); }
.sm-side-hint { margin: 6px 2px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }

.sm-side-list { display: flex; flex-direction: column; gap: 4px; }

.sm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}
.sm-item:hover { background: var(--bg-hover); }
.sm-item.is-active {
  background: var(--bg-secondary);
  border-color: var(--border);
  box-shadow: var(--shadow-xs);
}
.sm-item.is-off { opacity: 0.6; }
.sm-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.sm-item-thumb {
  width: 34px; height: 34px;
  flex: none;
  border-radius: 9px;
  background-size: cover;
  background-position: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.sm-item-thumb b {
  font-size: 14px;
  font-weight: 500;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
}
.sm-item-thumb.has-cover { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16); }

.sm-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.sm-item-name {
  display: flex; align-items: center; gap: 6px;
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sm-item-sub {
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sm-pin {
  flex: none;
  font-style: normal;
  font-size: 9.5px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 999px;
  background: var(--card-badge-bg);
  color: var(--card-badge-ink);
}
.sm-item-meta { display: none; }

.sm-item-add { color: var(--text-secondary); border-style: dashed; border-color: var(--border); }
.sm-item-add:hover { color: var(--accent); border-color: var(--accent); background: transparent; }
.sm-add-plus { font-size: 18px; line-height: 1; width: 34px; text-align: center; flex: none; }

/* ── 右栏：详情 ───────────────────────────────────────── */
.sm-main { min-width: 0; }
.sm-mobile-back { display: none; }

.sm-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 320px;
  border: 1.5px dashed var(--border-strong);
  border-radius: 18px;
  text-align: center;
  padding: 40px 16px;
}
.sm-placeholder-title { margin: 0; font-size: 15px; color: var(--text-primary); }
.sm-placeholder-sub { margin: 0; font-size: 12.5px; color: var(--text-secondary); }

.sm-form { display: flex; flex-direction: column; gap: 14px; }
.sm-field { display: flex; flex-direction: column; gap: 6px; }
.sm-field-label { font-size: 13px; color: var(--text-secondary); }
.sm-optional { font-size: 11px; color: var(--text-secondary); }

/* ── 窄屏：列表 ↔ 详情 两态 ───────────────────────────── */
@media (max-width: 900px) {
  .sm-page { padding: 14px 12px 40px; }
  .sm-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .sm-side { position: static; }
  .sm-layout.is-detail .sm-side { display: none; }
  .sm-layout:not(.is-detail) .sm-main { display: none; }
  .sm-mobile-back {
    display: inline-block;
    margin-bottom: 10px;
    border: none;
    background: none;
    padding: 4px 2px;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .sm-mobile-back:hover { color: var(--accent); }
  .sm-item { padding: 10px; }
  .sm-item-thumb { width: 40px; height: 40px; }
  .sm-item-meta { display: block; font-size: 11px; color: var(--text-secondary); flex: none; }
  .sm-title { font-size: 19px; }
}
</style>
