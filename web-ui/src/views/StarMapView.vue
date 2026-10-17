<template>
  <div class="page starmap-page">
    <header class="sm-head">
      <div class="sm-head-main">
        <h1 class="sm-title">星图</h1>
        <span class="sm-count">{{ worlds.length }} 个世界</span>
      </div>
      <linshe-button variant="primary" size="sm" @click="openCreate">+ 新建世界</linshe-button>
    </header>

    <div v-if="loading" class="sm-hint">正在展开星图…</div>

    <div v-else-if="!worlds.length" class="sm-empty">
      <p class="sm-empty-title">星图还是一片空白</p>
      <p class="sm-empty-sub">先创建一个世界，再把地图、角色放进去。</p>
      <linshe-button variant="primary" @click="openCreate">创建第一个世界</linshe-button>
    </div>

    <div v-else class="sm-grid">
      <article
        v-for="w in worlds"
        :key="w.id"
        class="sm-card"
        :class="{ 'is-active': w.is_active, 'is-off': !w.is_enabled }"
        role="button"
        tabindex="0"
        @click="openDetail(w)"
        @keydown.enter.prevent="openDetail(w)"
        @keydown.space.prevent="openDetail(w)"
      >
        <div class="sm-card-top">
          <span class="sm-dot" :style="{ background: dotColor(w.id) }"></span>
          <span class="sm-name">{{ w.name }}</span>
          <span v-if="w.is_active" class="sm-badge">激活</span>
          <span v-if="!w.is_enabled" class="sm-badge sm-badge-off">休眠</span>
        </div>
        <p class="sm-tagline">{{ w.tagline || '还没有一句话简介' }}</p>
        <div class="sm-meta">
          <span>{{ w.characterCount || 0 }} 角色 · {{ w.mapCount || 0 }} 地图</span>
        </div>
      </article>

      <button type="button" class="sm-card sm-card-add" @click="openCreate">
        <span class="sm-add-plus">+</span>
        <span class="sm-add-text">新建世界</span>
      </button>
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
import { ref, onMounted, inject } from 'vue'
import { useRouter } from 'vue-router'
import * as api from '../api/index.js'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import LinsheModal from '../components/ui/LinsheModal.vue'

const router = useRouter()
const toastFn = inject('toast')

const worlds = ref([])
const loading = ref(true)
const createOpen = ref(false)
const newName = ref('')
const newTagline = ref('')
const busy = ref(false)

const DOT_COLORS = [
  'var(--fun-purple)', 'var(--fun-pink)', 'var(--fun-orange)', 'var(--fun-teal)',
  'var(--fun-blue)', 'var(--fun-gold)', 'var(--fun-violet)',
]
const dotColor = (id) => DOT_COLORS[Math.abs(Number(id) || 0) % DOT_COLORS.length]

async function loadWorlds() {
  loading.value = true
  try {
    const r = await api.getWorldSettings()
    worlds.value = Array.isArray(r) ? r : (r?.list || [])
  } catch (err) {
    toastFn?.('星图读取失败：' + (err?.message || ''), 'error')
  } finally {
    loading.value = false
  }
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
    if (id) router.push('/starmap/' + id)
    else await loadWorlds()
  } catch (err) {
    toastFn?.('创建失败：' + (err?.message || ''), 'error')
  } finally {
    busy.value = false
  }
}

function openDetail(w) {
  router.push('/starmap/' + w.id)
}

onMounted(loadWorlds)
</script>

<style scoped>
.starmap-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px 20px 48px;
  box-sizing: border-box;
}
.sm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.sm-head-main { display: flex; align-items: baseline; gap: 10px; }
.sm-title { font-size: 22px; font-weight: 500; margin: 0; color: var(--text-bright); }
.sm-count { font-size: 12px; color: var(--text-secondary); }
.sm-hint { color: var(--text-secondary); font-size: 13px; padding: 40px 0; text-align: center; }

.sm-empty {
  text-align: center;
  padding: 64px 16px;
  background: #f4f1ee;
  color: #554a43;
  border: 1.5px solid #cbb599;
  border-radius: 20px;
}
.sm-empty-title { margin: 0 0 6px; font-size: 16px; font-weight: 500; }
.sm-empty-sub { margin: 0 0 18px; font-size: 13px; color: #76665a; }

.sm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

.sm-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 16px 14px;
  border-radius: 16px;
  background: #f4f1ee;
  color: #554a43;
  border: 1.5px solid #cbb599;
  box-shadow: 0 2px 0 rgba(53, 42, 35, 0.08);
  cursor: pointer;
  text-align: left;
  transition: transform var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard);
}
.sm-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(53, 42, 35, 0.14);
}
.sm-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sm-card.is-off { opacity: 0.62; }

.sm-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sm-dot {
  width: 9px; height: 9px; border-radius: 50%;
  flex: none;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.55);
}
.sm-name {
  font-size: 15px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sm-badge {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 999px;
  background: #ae6451;
  color: #fff7ef;
}
.sm-badge-off { background: #9b8c80; }

.sm-tagline {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: #76665a;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 39px;
}
.sm-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: #9b8c80;
}

.sm-card-add {
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-style: dashed;
  background: transparent;
  color: #9b8c80;
  box-shadow: none;
}
.sm-card-add:hover { color: #ae6451; border-color: #ae6451; }
.sm-add-plus { font-size: 22px; line-height: 1; }
.sm-add-text { font-size: 13px; }

.sm-form { display: flex; flex-direction: column; gap: 14px; }
.sm-field { display: flex; flex-direction: column; gap: 6px; }
.sm-field-label { font-size: 13px; color: var(--text-secondary); }
.sm-optional { font-size: 11px; color: var(--text-tertiary); }

@media (max-width: 560px) {
  .starmap-page { padding: 14px 12px 40px; }
  .sm-grid { grid-template-columns: 1fr; }
  .sm-title { font-size: 19px; }
}
</style>
