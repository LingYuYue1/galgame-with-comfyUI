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

        <!-- ★ 2026-10-18 二改：左栏不是「导航列表」，是**竖排的世界卡片**——
             色点 / 名称 / 徽标 / 一句话 / 居民头像 / 角色·地图计数，一样都不能少。
             做成设置页那种行式列表确实更"整齐"，但把卡片的辨识度和居民头像全丢了，
             等于把上一轮做的东西白扔。 -->
        <div v-else class="sm-stack">
          <article
            v-for="w in worlds"
            :key="w.id"
            class="sm-card"
            :class="{
              'is-current': w.id === selectedId,
              'is-off': !w.is_enabled,
              'has-cover': !!w.cover_image,
            }"
            :style="w.cover_image ? { backgroundImage: `url(${w.cover_image})` } : null"
            role="button"
            tabindex="0"
            @click="select(w)"
            @keydown.enter.prevent="select(w)"
            @keydown.space.prevent="select(w)"
          >
            <div class="sm-card-top">
              <span class="sm-dot" :style="{ background: dotColor(w.id) }"></span>
              <span class="sm-name">{{ w.name }}</span>
              <span v-if="w.is_active" class="sm-badge">激活</span>
              <span v-if="!w.is_enabled" class="sm-badge sm-badge-off">休眠</span>
            </div>
            <p class="sm-tagline">{{ w.tagline || '还没有一句话简介' }}</p>

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

/** 卡片最多叠 5 个头像，多的用 +N（后端最多给 8 个，够算差值） */
const AVATAR_SHOW = 5
function visibleChars(w) {
  return (w.characters || []).slice(0, AVATAR_SHOW)
}

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
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

/* ── 左栏：世界卡片（竖排堆叠，保留卡片墙那套视觉语言）─────────
   为什么不做成行式列表：行式列表是"导航控件"的语言，一行只有名字，
   世界之间的气质差异（色点、封面、住着谁）全被压平了。
   这里仍然是**卡片**，只是从网格改成竖排。 */
.sm-side {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  max-height: calc(100vh - 40px);
}
.sm-side-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px; flex: none; }
.sm-title { font-size: 20px; font-weight: 500; margin: 0; color: var(--text-bright); }
.sm-count { font-size: 12px; color: var(--text-secondary); }
.sm-side-hint { margin: 6px 2px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; flex: none; }

/* 世界多了左栏自己滚，不把整页顶长 */
.sm-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  /* 2px 外扩：hover 抬升与描边阴影不被滚动容器裁掉 */
  padding: 2px;
  margin: -2px;
}

.sm-card {
  position: relative;
  overflow: hidden;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 14px 12px;
  border-radius: 16px;
  background: var(--card-paper);
  color: var(--card-ink);
  border: 1.5px solid var(--card-line);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  text-align: left;
  background-size: cover;
  background-position: center;
  min-height: 126px;
  transition: transform var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    border-color var(--dur-base) var(--ease-standard);
}
.sm-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.sm-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sm-card.is-off { opacity: 0.62; }
/* 选中态：不铺灰底（那是导航行的语言），只把描边换成强调色 + 轻抬阴影。
   描边掺一点纸色 —— 纯 --accent 在暖色主题下会跳成"警告框"，抢掉卡片本身的图形。
   ★ 再补一条左侧竖条：有封面的卡边框是半透明白，光靠"白→纯白"根本看不出选中。 */
.sm-card.is-current {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--card-line));
  box-shadow: var(--shadow-sm);
}
.sm-card.is-current::after {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
  z-index: 2;          /* 压在封面遮罩与内容之上 */
}

/* 封面图上的可读性保险：压一层自上而下加深的暗色渐变。
   顶部 30% 起手就要够重 —— 天空、雪景这类高亮区域在 18% 遮罩下会把白字吃掉。 */
.sm-card.has-cover::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(18, 14, 12, 0.34) 0%, rgba(18, 14, 12, 0.62) 46%, rgba(18, 14, 12, 0.88) 100%);
  pointer-events: none;
}
.sm-card.has-cover > * { position: relative; z-index: 1; }
.sm-card.has-cover {
  border-color: rgba(255, 255, 255, 0.22);
  color: #fff;
}
.sm-card.has-cover .sm-name { color: #fff; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); }
.sm-card.has-cover .sm-tagline { color: rgba(255, 255, 255, 0.92); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
.sm-card.has-cover .sm-meta { color: rgba(255, 255, 255, 0.86); text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
.sm-card.has-cover .sm-ava { border-color: rgba(255, 255, 255, 0.75); }
.sm-card.has-cover .sm-dot { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.55); }
.sm-card.has-cover.is-current { border-color: #fff; }

.sm-card-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.sm-dot {
  width: 9px; height: 9px; border-radius: 50%;
  flex: none;
  box-shadow: 0 0 0 2px var(--card-paper);   /* 纸色描边，让色点"浮"在纸面上 */
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
  background: var(--card-badge-bg);
  color: var(--card-badge-ink);
}
.sm-badge-off { background: var(--card-ink-muted); color: var(--card-paper); }

.sm-tagline {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--card-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 39px;
}

/* 卡片底部：居民头像（左）+ 计数（右）—— 头像是"这里住着谁"的第一眼信息 */
.sm-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
}
.sm-foot .sm-meta { margin-left: auto; }
.sm-meta {
  font-size: 11.5px;
  color: var(--card-ink-muted);
}
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
  background: #8a6550 center/cover no-repeat;   /* 无头像时的占位棕底：白字 5.17，两套主题都成立 */
  border: 2px solid var(--card-paper);          /* 与纸面同色，叠起来才有"叠"的层次 */
  box-sizing: content-box;
  overflow: hidden;
}
.sm-ava + .sm-ava { margin-left: -7px; }
.sm-ava-more {
  background: var(--card-paper-raised);
  color: var(--card-ink-muted);
  font-size: 10px;
}

/* 新建世界：虚线卡（和世界卡同一族，不抢戏） */
.sm-card-add {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 54px;
  padding: 12px;
  border-style: dashed;
  background: transparent;
  border-color: var(--card-line);
  color: var(--card-ink-muted);
  box-shadow: none;
}
.sm-card-add:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: none;
  box-shadow: none;
}
.sm-add-plus { font-size: 20px; line-height: 1; }
.sm-add-text { font-size: 13px; }

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
  .sm-side { position: static; max-height: none; }
  .sm-stack { overflow: visible; }
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
  /* 手机上卡片可以矮一点，纵向空间更值钱 */
  .sm-card { min-height: 112px; }
  .sm-card-add { min-height: 48px; }
  .sm-title { font-size: 19px; }
}
</style>
