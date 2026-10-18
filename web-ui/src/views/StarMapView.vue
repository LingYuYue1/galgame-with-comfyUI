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
        :class="{ 'is-active': w.is_active, 'is-off': !w.is_enabled, 'has-cover': !!w.cover_image }"
        :style="w.cover_image ? { backgroundImage: `url(${w.cover_image})` } : null"
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

        <!-- ★ 2026-10-18：底部一行 = 居民头像（左）+ 计数（右）。
             头像是"这里住着谁"的第一眼信息；没有头像的角色用首字占位，不空着。 -->
        <div class="sm-foot">
          <div v-if="(w.characters || []).length" class="sm-avatars">
            <span
              v-for="c in visibleChars(w)"
              :key="c.id"
              class="sm-ava"
              :title="c.display_name || c.name"
              :style="c.avatar_path ? { backgroundImage: `url(${c.avatar_path})` } : null"
            >{{ c.avatar_path ? '' : (c.display_name || c.name || '?').slice(0, 1) }}</span>
            <span v-if="(w.characterCount || 0) > visibleChars(w).length" class="sm-ava sm-ava-more">
              +{{ (w.characterCount || 0) - visibleChars(w).length }}
            </span>
          </div>
          <span class="sm-meta">{{ w.characterCount || 0 }} 角色 · {{ w.mapCount || 0 }} 地图</span>
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

/** 卡片最多叠 5 个头像，多的用 +N（后端最多给 8 个，够算差值） */
const AVATAR_SHOW = 5
function visibleChars(w) {
  return (w.characters || []).slice(0, AVATAR_SHOW)
}

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
  position: relative;          /* 封面图的遮罩层要靠它定位 */
  overflow: hidden;            /* 圆角裁掉背景图与遮罩的直角 */
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
  background-size: cover;
  background-position: center;
  min-height: 132px;           /* 有封面时高度更稳，不会因为简介两行/一行跳动 */
}

/* ★ 封面图上的可读性保险：压一层自上而下加深的暗色渐变。
   不做这层，任何浅色照片都会让纸色文字直接消失（亮/暗主题都一样）。 */
.sm-card.has-cover::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(24, 18, 14, 0.18) 0%, rgba(24, 18, 14, 0.62) 62%, rgba(24, 18, 14, 0.78) 100%);
  pointer-events: none;
}
.sm-card.has-cover > * { position: relative; z-index: 1; }
.sm-card.has-cover {
  border-color: rgba(255, 255, 255, 0.28);
  color: #fff;
}
.sm-card.has-cover .sm-name { color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45); }
/* 白字压在 ≥62% 的暗色渐变上：对任意照片的最坏情况仍 ≥4.5（渐变底色亮度足够低） */
.sm-card.has-cover .sm-tagline { color: rgba(255, 255, 255, 0.9); }
.sm-card.has-cover .sm-meta { color: rgba(255, 255, 255, 0.82); }
.sm-card.has-cover .sm-ava { border-color: rgba(255, 255, 255, 0.7); }
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
  /* 暖纸底是恒亮的（质感岛特例），所以徽标文字/底色按「亮底」算对比度：
     原 #ae6451 配 #fff7ef 实测 4.18，未过 4.5 → 压深到 5.1 */
  background: #9c5745;
  color: #fff7ef;
}
.sm-badge-off { background: #6f6359; }

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
  /* 亮纸上的次要文字：#9b8c80 实测仅 2.89 → 压到 #746759 得 4.57 */
  color: #746759;
}

/* ── 卡片底部：居民头像（左）+ 计数（右）────────────────────
   头像叠放（负 margin），每个 24px；没有头像的角色用首字占位 —— 空圆比首字更像"坏图"。 */
.sm-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;            /* 贴底：简介短的世界不会让底行浮在中间 */
}
.sm-foot .sm-meta { margin-left: auto; }
.sm-avatars { display: flex; align-items: center; min-width: 0; }
.sm-ava {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #fff;
  background: #a8826a center/cover no-repeat;
  border: 2px solid #f4f1ee;   /* 与纸面同色，叠起来才有"叠"的层次 */
  box-sizing: content-box;
  overflow: hidden;
}
.sm-ava + .sm-ava { margin-left: -7px; }
.sm-ava-more {
  background: #d9cfc3;
  color: #5c4d42;
  font-size: 10px;
}

.sm-card-add {
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-style: dashed;
  background: transparent;
  /* 这张卡不在暖纸上（横跨页面底色），必须跟主题翻转 → 用主题变量，
     不写死灰色（写死 #9b8c80 在暗夜 5.65 合格、在亮色反而不够） */
  color: var(--text-secondary);
  box-shadow: none;
}
.sm-card-add:hover { color: var(--accent); border-color: var(--accent); }
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
