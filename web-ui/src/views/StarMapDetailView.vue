<template>
  <div class="page smd-page" :class="{ 'is-embedded': embedded }">
    <header class="smd-head">
      <button v-if="!embedded" type="button" class="smd-back" @click="router.push('/starmap')">← 星图</button>
      <div class="smd-title-wrap">
        <h1 class="smd-title">{{ world?.name || '世界' }}</h1>
        <span v-if="world?.is_core" class="smd-badge">主世界</span>
      </div>
      <div class="smd-head-actions">
        <linshe-button
          v-if="world && !world.is_core"
          variant="secondary"
          size="sm"
          title="主世界是所有角色共用的骨架规则，会和每个角色自己归属的世界一起注入"
          @click="makeActive"
        >设为主世界</linshe-button>
        <linshe-switch
          v-if="world && !world.is_core"
          :model-value="!!world.is_enabled"
          size="sm"
          title="世界开关：休眠后不参与媒体抽卡与后台任务"
          @change="saveEnabled"
        />
        <linshe-button variant="ghost" size="sm" title="卡片封面图（会铺在星图首页的这张卡上）" @click="coverOpen = true">封面</linshe-button>
        <linshe-button variant="ghost" size="sm" @click="openRename">重命名</linshe-button>
        <linshe-button variant="danger" size="sm" @click="removeWorld">删除</linshe-button>
      </div>
    </header>

    <!-- 只有一个页签时不渲染页签组：单个选项既没有"切换"的意义，
         还会被组件拉满整行、看起来像一条高亮横条。 -->
    <linshe-tabs
      v-if="tabOptions.length > 1"
      v-model="tab"
      class="smd-tabs"
      :options="tabOptions"
    />

    <!-- 主世界是骨架：没有地图、没有居民、没有旅程。它不是"一个地方"，是一段通则。
         所以这里只留世界观编辑器，其余页签整组不渲染。 -->
    <p v-if="world?.is_core" class="smd-core-note">
      这是主世界。它是<strong>所有世界共用的通则</strong>，会常驻叠加在每个角色的提示词最前面；
      具体的地理、居民、旅程都在下面那些副世界里。
    </p>

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
          <linshe-input v-model="tagline" placeholder="一句话说清这个世界的样子" @blur="saveTagline" />
        </label>
        <label class="smd-field">
          <span class="smd-field-label">视觉基调<span class="smd-optional">（≤60 字，会拼入生图环境）</span></span>
          <linshe-input v-model="visualTone" maxlength="60" placeholder="色调、光线、材质…例如：湿冷的青灰石巷，暖黄灯火" @blur="saveTone" />
        </label>

        <!-- ★ 2026-10-18：移动型世界（载具）。
             载具型世界没有固定地理，角色今天停在这个星球、明天停在另一个。
             勾上之后，一键编排日程会让她落在**任意世界**的地图上，而不是锁死在车厢里。
             ⚠ 这里只写通用表述 —— 前端不得内置任何世界观专有名词（护栏见
             agent-core/test/worldProjectLibrary.test.js，多行 HTML 注释的续行同样会被扫到）。 -->
        <div class="smd-vehicle-row">
          <linshe-switch
            :model-value="!!world?.is_vehicle"
            size="sm"
            @change="saveVehicle"
          />
          <div class="smd-vehicle-text">
            <span class="smd-vehicle-title">移动型世界（载具）</span>
            <span class="smd-vehicle-sub">
              这个世界的角色可以停在任何世界的地图上 —— 适合星穹列车这类会跑的地方。
              不勾 = 地点只从本世界的地图取。
            </span>
          </div>
        </div>
      </div>
    </section>

    <section v-else-if="tab === 'map'" class="smd-body">
      <div class="smd-list">
        <div v-if="!maps.length" class="smd-hint">这个世界还没有地图。新建一张，AI 会按世界观铺出地点骨架。</div>
      </div>

      <!-- ★ 2026-10-18：地图不再是"一行字"，而是真的把地点铺出来，并在对应地点叠上此刻在那儿的角色头像 -->
      <div v-for="m in mapCards" :key="m.id" class="smd-map-block">
        <div class="smd-map-head">
          <span class="smd-map-name">{{ m.name }}</span>
          <span class="smd-map-count">{{ m.place_count || 0 }} 个地点</span>
          <linshe-button variant="ghost" size="sm" class="smd-map-open" @click="router.push('/worldmap')">打开地图页</linshe-button>
        </div>

        <p v-if="!m.tree.length" class="smd-hint smd-map-empty">
          这张图还是空的。去地图页用「从世界观生成」一键铺出大地区与子地区。
        </p>

        <!-- ★ 2026-10-18：可以一路展开到场景与生活地点。
             只是想"看看这世界有什么"的话，不必跳去地图页。纯只读，不给编辑入口。 -->
        <div v-else class="smd-tree">
          <div v-for="l1 in m.tree" :key="l1.id" class="smd-branch is-l1">
            <button
              type="button"
              class="smd-node"
              :class="{ 'is-leaf': !canExpand(l1), 'is-open': isOpen(l1.id) }"
              :title="l1.summary || l1.name"
              @click="canExpand(l1) && togglePlace(l1.id)"
            >
              <span class="smd-caret">{{ canExpand(l1) ? (isOpen(l1.id) ? '▾' : '▸') : '' }}</span>
              <span class="smd-node-name">{{ l1.name }}</span>
              <span v-if="(l1.children || []).length" class="smd-node-badge">{{ l1.children.length }} 区</span>
              <span v-if="(m.byPlace[l1.id] || []).length" class="smd-node-people">
                <span
                  v-for="r in (m.byPlace[l1.id] || []).slice(0, 4)"
                  :key="r.id"
                  class="smd-place-ava"
                  :title="r.name + (r.location ? ' · ' + r.location : '')"
                  :style="r.avatar_path ? { backgroundImage: `url(${r.avatar_path})` } : null"
                >{{ r.avatar_path ? '' : (r.name || '?').slice(0, 1) }}</span>
                <span v-if="(m.byPlace[l1.id] || []).length > 4" class="smd-place-ava is-more">
                  +{{ (m.byPlace[l1.id] || []).length - 4 }}
                </span>
              </span>
            </button>

            <div v-if="isOpen(l1.id)" class="smd-kids">
              <div v-for="l2 in l1.children" :key="l2.id" class="smd-branch is-l2">
                <button
                  type="button"
                  class="smd-node"
                  :class="{ 'is-leaf': !canExpand(l2), 'is-open': isOpen(l2.id) }"
                  :title="l2.summary || l2.name"
                  @click="canExpand(l2) && togglePlace(l2.id)"
                >
                  <span class="smd-caret">{{ canExpand(l2) ? (isOpen(l2.id) ? '▾' : '▸') : '' }}</span>
                  <span class="smd-node-name">{{ l2.name }}</span>
                  <span v-if="(l2.children || []).length" class="smd-node-badge">{{ l2.children.length }} 处</span>
                  <span v-else-if="(l2.pois || []).length" class="smd-node-badge is-poi">{{ l2.pois.length }} 生活点</span>
                  <span v-if="(m.byPlace[l2.id] || []).length" class="smd-node-people">
                    <span
                      v-for="r in (m.byPlace[l2.id] || []).slice(0, 4)"
                      :key="r.id"
                      class="smd-place-ava"
                      :title="r.name + (r.location ? ' · ' + r.location : '')"
                      :style="r.avatar_path ? { backgroundImage: `url(${r.avatar_path})` } : null"
                    >{{ r.avatar_path ? '' : (r.name || '?').slice(0, 1) }}</span>
                    <span v-if="(m.byPlace[l2.id] || []).length > 4" class="smd-place-ava is-more">
                      +{{ (m.byPlace[l2.id] || []).length - 4 }}
                    </span>
                  </span>
                </button>

                <div v-if="isOpen(l2.id)" class="smd-leaf-list">
                  <div v-for="l3 in l2.children" :key="l3.id" class="smd-leaf">
                    <span class="smd-leaf-name">{{ l3.name }}</span>
                    <span
                      v-for="r in (m.byPlace[l3.id] || [])"
                      :key="r.id"
                      class="smd-place-ava"
                      :title="r.name + (r.location ? ' · ' + r.location : '')"
                      :style="r.avatar_path ? { backgroundImage: `url(${r.avatar_path})` } : null"
                    >{{ r.avatar_path ? '' : (r.name || '?').slice(0, 1) }}</span>
                    <span v-for="(poi, pi) in (l3.pois || [])" :key="pi" class="smd-poi" :title="poi.blurb || ''">{{ poi.name }}</span>
                  </div>
                  <div v-if="!(l2.children || []).length" class="smd-leaf">
                    <span v-for="(poi, pi) in (l2.pois || [])" :key="pi" class="smd-poi" :title="poi.blurb || ''">{{ poi.name }}</span>
                  </div>
                  <p v-if="!(l2.children || []).length && !(l2.pois || []).length" class="smd-leaf-empty">
                    这个子地区还没展开。去地图页点「展开」可以让 AI 补出场景与生活地点。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <p v-if="m.unplaced.length" class="smd-map-unplaced">
          <span class="smd-map-unplaced-label">不在地图上：</span>
          <span
            v-for="r in m.unplaced"
            :key="r.id"
            class="smd-map-unplaced-item"
            :title="r.location ? '她的日程地点写着「' + r.location + '」，和这张图上的地名对不上' : '今天还没有日程'"
          >
            <span
              class="smd-place-ava"
              :style="r.avatar_path ? { backgroundImage: `url(${r.avatar_path})` } : null"
            >{{ r.avatar_path ? '' : (r.name || '?').slice(0, 1) }}</span>
            {{ r.name }}
          </span>
        </p>
      </div>

      <div class="smd-foot-actions">
        <linshe-button variant="primary" size="sm" :loading="mapBusy" @click="openCreateMap">+ 在这个世界建一张地图</linshe-button>
      </div>
    </section>

    <section v-else-if="tab === 'char'" class="smd-body">
      <div class="smd-list">
        <div v-if="!chars.length" class="smd-hint">还没有角色归属这个世界。</div>
        <div v-for="c in chars" :key="c.id" class="smd-row">
          <!-- 星图首页的卡片都在用头像，这里只有首字就断档了；
               没设头像的角色才退回首字占位（与卡片同一口径）。 -->
          <span
            class="smd-avatar"
            :class="{ 'has-img': !!c.avatar_path }"
            :style="c.avatar_path ? { backgroundImage: `url(${c.avatar_path})` } : null"
          >{{ c.avatar_path ? '' : (c.display_name || c.name || '?').slice(0, 1) }}</span>
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

      <!-- ★ 星图 T10：把角色放进这个世界（不指定 = 只吃主世界骨架） -->
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
        也可以点「聊天」左侧的角色卡，在「所在世界」里改；不指定时只吃主世界骨架，不吃任何一个具体世界。
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

    <!-- ★ 2026-10-18：世界封面（星图卡片背景图） -->
    <linshe-modal v-model="coverOpen" title="世界封面">
      <div class="smd-cover-form">
        <div
          v-if="world?.cover_image"
          class="smd-cover-preview"
          :style="{ backgroundImage: `url(${world.cover_image})` }"
        >
          <span v-if="coverStage" class="smd-cover-veil">{{ coverStage }}</span>
        </div>
        <p class="smd-hint">
          封面会铺在星图首页的这张卡上。AI 会读你的世界观，画一张 1216×832 的横幅环境图；
          也可以自己上传（自动压到 1600px 宽 / JPEG）。
        </p>

        <!-- AI 生成：先看提示词，再决定画不画 -->
        <label class="smd-field">
          <span class="smd-field-label">
            画面要求<span class="smd-optional">（可留空，AI 自己从世界观里找画面；填了就按你的来）</span>
          </span>
          <linshe-input
            v-model="coverExtra"
            placeholder="例如：雪夜的港口，不要霓虹"
            :disabled="coverBusy"
            @keyup.enter="generateCover"
          />
        </label>
        <div v-if="coverPrompt" class="smd-cover-prompt">
          <span class="smd-cover-prompt-label">这次用的提示词</span>
          <p class="smd-cover-prompt-text">{{ coverPrompt }}</p>
        </div>

        <input ref="coverInput" type="file" accept="image/*" class="smd-cover-file" @change="onCoverPicked" />
        <div class="smd-cover-actions">
          <linshe-button variant="primary" size="sm" :loading="coverBusy" @click="generateCover">AI 生成封面</linshe-button>
          <linshe-button variant="secondary" size="sm" :disabled="coverBusy" @click="pickCover">选择图片</linshe-button>
          <!-- ★ 2026-10-18：和角色头像同一个机制 —— 从「近期生成」里挑一张，不用上传 -->
          <linshe-button variant="secondary" size="sm" :disabled="coverBusy" @click="toggleRecent">
            {{ recentOpen ? '收起近期图' : '近期生成' }}
          </linshe-button>
          <linshe-button
            v-if="world?.cover_image"
            variant="ghost"
            size="sm"
            :disabled="coverBusy"
            @click="clearCover"
          >清除封面</linshe-button>
        </div>

        <div v-if="recentOpen" class="smd-recent">
          <p v-if="recentLoading" class="smd-hint">正在翻最近的图…</p>
          <p v-else-if="!recentImages.length" class="smd-hint">还没有生成过图片。先去聊几句，或者用上面的「AI 生成封面」。</p>
          <div v-else class="smd-recent-grid">
            <button
              v-for="(u, i) in recentImages"
              :key="i"
              type="button"
              class="smd-recent-item"
              :class="{ 'is-picked': u === world?.cover_image }"
              :style="{ backgroundImage: `url(${u})` }"
              :title="u === world?.cover_image ? '当前封面' : '用这张当封面'"
              :disabled="coverBusy"
              @click="applyRecentCover(u)"
            ></button>
          </div>
        </div>
      </div>
    </linshe-modal>

    <!-- ★ 2026-10-18：在这里就能给当前世界建地图（不必先跑去地图页再选世界） -->
    <linshe-modal v-model="mapModalOpen" title="建一张新地图">
      <div class="smd-cover-form">
        <p class="smd-hint">
          地图会挂在这个世界下。填一句话说明要什么地理结构，AI 会按世界观铺出大地区与子地区（之后还能逐区展开）。
        </p>
        <label class="smd-field">
          <span class="smd-field-label">地图名</span>
          <linshe-input v-model="newMapName" placeholder="例如：王城 · 全域" @keyup.enter="confirmCreateMap" />
        </label>
        <label class="smd-field">
          <span class="smd-field-label">地理构想<span class="smd-optional">（可留空，AI 自己按世界观想）</span></span>
          <linshe-input v-model="newMapBrief" placeholder="例如：一张漂浮在云海上的环形城，分上城与下城" />
        </label>
      </div>
      <template #footer>
        <linshe-button variant="secondary" @click="mapModalOpen = false">取消</linshe-button>
        <linshe-button variant="primary" :disabled="!newMapName.trim() || mapBusy" :loading="mapBusy" @click="confirmCreateMap">创建并生成</linshe-button>
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
import { ref, computed, watch, onMounted, onUnmounted, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as api from '../api/index.js'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import LinsheTabs from '../components/ui/LinsheTabs.vue'
import LinsheSwitch from '../components/ui/LinsheSwitch.vue'
import LinsheSelect from '../components/ui/LinsheSelect.vue'
import LinsheModal from '../components/ui/LinsheModal.vue'

// ★ 2026-10-18：改成「可嵌入」——星图首页是左列表右详情，详情作为右栏常驻组件。
//   · 当路由页用时 worldId 从 route.params.id 取（老链接 /starmap/11 仍然直达）
//   · 当组件用时由父级传 world-id，切换世界不重挂载，只 watch 重载
const props = defineProps({
  embedded: { type: Boolean, default: false },
  worldId: { type: [Number, String], default: null },
})
// changed：左栏要跟着刷（改名/简介/激活/开关/角色数都会影响列表项）
// removed：世界被删掉了，父级要回到空态
const emit = defineEmits(['changed', 'removed'])

const route = useRoute()
const router = useRouter()
const toastFn = inject('toast')

const worldId = computed(() => Number(props.worldId ?? route.params.id))
const world = ref(null)
const content = ref('')
const tagline = ref('')
const visualTone = ref('')
const dirty = ref(false)
const saving = ref(false)
const polishing = ref(false)
const activating = ref(false)
const tab = ref('world')
/**
 * 页签清单按世界类型分流（2026-10-18）。
 *
 * 主世界是**骨架**，不是"一个地方"：它没有地图、没有居民、没有旅程。
 * 这四个页签在副世界上是对的，在骨架上是语义错误（打开会看到"0 角色 · 0 地图"，
 * 还能给它建图、往里塞人）。
 */
const tabOptions = computed(() =>
  world.value?.is_core
    ? [{ label: '世界观', value: 'world' }]
    : [
        { label: '世界观', value: 'world' },
        { label: '地图', value: 'map' },
        { label: '角色', value: 'char' },
        { label: '旅程', value: 'trip' },
      ]
)
const maps = ref([])
/** 地图页签的可视数据：每张图 + 地点（L1/L2）+ 此刻站在那儿的人 */
const mapCards = ref([])
const mapBusy = ref(false)
const mapModalOpen = ref(false)
const newMapName = ref('')
const newMapBrief = ref('')
const chars = ref([])
// ★ 星图 T10：全部角色（用于「把角色放进这个世界」的候选）；pickCharId 用空串表示未选
const allChars = ref([])
const pickCharId = ref('')
const busyChar = ref(false)
const renameOpen = ref(false)
const renameValue = ref('')

// ★ 2026-10-18：世界封面
const coverOpen = ref(false)
const coverBusy = ref(false)
const coverInput = ref(null)
/** 「近期生成」选择区：懒加载，展开过一次就复用（同一次弹窗会话内不必反复请求） */
const recentOpen = ref(false)
const recentLoading = ref(false)
const recentImages = ref([])

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
      label: `${w.name}${w.is_core ? ' · 主世界' : (w.is_enabled ? '' : ' · 休眠')}`,
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
    // 主世界只有「世界观」一个页签 —— 若当前停在别的页签（例如刚从副世界切过来），
    // 不归位就会渲染出一片空白右栏。
    if (world.value.is_core && tab.value !== 'world') tab.value = 'world'
  } catch (err) {
    toastFn?.('读取失败：' + (err?.message || ''), 'error')
  }
  try {
    const mr = await api.listWorldMaps()
    const all = mr?.maps || []
    maps.value = all.filter((m) => Number(m.world_setting_id) === worldId.value)
    await loadMapCards()
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

/**
 * 地图页签的可视数据。
 * 每张图两次请求：地点骨架（只取 L1/L2，L3 与 POI 在这里太碎）+ 此刻谁在哪个地点。
 * 地图数量是个位数，串行够用；并行出错时反而不知道是哪张图挂的。
 */
async function loadMapCards() {
  const out = []
  for (const m of maps.value) {
    let places = []
    let tree = []
    let byPlace = {}
    let residents = []
    try {
      const d = await api.getWorldMap(m.id)
      // ★ 2026-10-18：不再只取 L1/L2 —— 星图里要能一路展开到场景与生活地点，
      //   所以保留全量扁平表（算数量用）与后端已装好的嵌套树（渲染用，前端不必自己分组）。
      places = d?.map?.places || []
      tree = d?.map?.tree || []
    } catch { /* 单张图读失败不影响其它图 */ }
    try {
      const r = await api.getWorldMapResidents(m.id)
      byPlace = r?.by_place || {}
      residents = r?.residents || []
    } catch { /* 没有 residents 接口时退化成"只有地点没有头像" */ }
    out.push({
      ...m,
      places,
      tree,
      byPlace,
      // 有角色但日程地点没落到任何地点上（写的是「家里」这种图外地名，或今天还没排日程）
      unplaced: residents.filter(x => !x.place_id),
    })
  }
  mapCards.value = out
  // 大地区默认摊开（与改版前看到的一致：L1 + 它的 L2），再往下的层级等用户自己点。
  if (!expandedPlaces.value.size) {
    const s = new Set()
    for (const m of out) for (const n of m.tree) if ((n.children || []).length) s.add(n.id)
    expandedPlaces.value = s
  }
}

/** 展开状态（place id 集合）。只活在本次会话里，不落盘 —— 纯浏览偏好，不值得存库。 */
const expandedPlaces = ref(new Set())
function isOpen(id) { return expandedPlaces.value.has(id) }
function togglePlace(id) {
  const s = new Set(expandedPlaces.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedPlaces.value = s
}
/** 这一层下面还有东西可展开吗：有子地区，或者有生活地点 */
function canExpand(n) { return (n.children || []).length > 0 || (n.pois || []).length > 0 }

function openCreateMap() {
  newMapName.value = ''
  newMapBrief.value = ''
  mapModalOpen.value = true
}

async function confirmCreateMap() {
  const name = newMapName.value.trim()
  if (!name || mapBusy.value) return
  mapBusy.value = true
  try {
    const created = await api.createWorldMap({ name, worldSettingId: worldId.value, note: newMapBrief.value.trim() })
    const mapId = created?.map?.id
    if (!mapId) throw new Error('地图创建失败')
    // 顺手生成骨架：只建一张空图没意义，用户要的是"能看见的地理"
    await api.generateWorldMapSkeleton(mapId, { brief: newMapBrief.value.trim() })
    mapModalOpen.value = false
    const mr = await api.listWorldMaps()
    maps.value = (mr?.maps || []).filter((m) => Number(m.world_setting_id) === worldId.value)
    await loadMapCards()
    emit('changed')
    toastFn?.('地图已建好', 'success')
  } catch (err) {
    toastFn?.('建图失败：' + (err?.message || ''), 'error')
  } finally {
    mapBusy.value = false
  }
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
    emit('changed')
    toastFn?.(targetWorldId ? '已放进这个世界' : '已移出（只吃主世界骨架）', 'success')
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
    emit('changed')
  } catch (err) {
    toastFn?.('保存失败：' + (err?.message || ''), 'error')
  } finally {
    saving.value = false
  }
}

/**
 * 简介 / 视觉基调：**各自只提交自己那一栏**。
 *
 * ★ 2026-10-18 实锤 bug：这两栏原来共用 `saveMeta()`，一次提交两个字段。
 *   于是任意一个输入框失焦，都会把**另一个字段的当前页面值**一起写回数据库 ——
 *   页面状态一旦是旧的/空的（例如刚打开还没渲染完就点了一下别处），
 *   就会把库里本来有值的那一栏清空。罗浮的 visual_tone 就是这样被清掉的。
 *   拆成两个函数后，谁失焦只保存谁。
 */
async function saveTagline() {
  try {
    await api.updateWorldSetting(worldId.value, { tagline: tagline.value })
    emit('changed')
  } catch (err) {
    toastFn?.('保存失败：' + (err?.message || ''), 'error')
  }
}

async function saveTone() {
  try {
    await api.updateWorldSetting(worldId.value, { visual_tone: visualTone.value })
    emit('changed')
  } catch (err) {
    toastFn?.('保存失败：' + (err?.message || ''), 'error')
  }
}

/** 移动型世界（载具）：勾上/取消后立刻生效，下次编排日程就会按新规则取地点 */
async function saveVehicle(val) {
  try {
    await api.updateWorldSetting(worldId.value, { is_vehicle: !!val })
    if (world.value) world.value.is_vehicle = val ? 1 : 0
    emit('changed')
    toastFn?.(val ? '已设为移动型世界 —— 角色会出现在任何星球的地图上' : '已改回固定世界', 'success')
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
    emit('changed')
    toastFn?.('已设为主世界', 'success')
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
    emit('changed')
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
    emit('changed')
    toastFn?.('已重命名', 'success')
  } catch (err) {
    toastFn?.('重命名失败：' + (err?.message || ''), 'error')
  }
}

// ── 世界封面 ─────────────────────────────────────────────
const coverExtra = ref('')     // 用户补充的画面要求（可留空）
const coverPrompt = ref('')    // 这次实际用的提示词（给用户看，免得"不知道 AI 在想什么"）
const coverStage = ref('')     // 生成中的阶段提示，压在预览图上

function pickCover() {
  if (coverBusy.value) return
  coverInput.value?.click()
}

/**
 * 展开「近期生成」。
 *
 * 与角色头像选择器同一套数据源（`image_tasks`），但**不按角色过滤** ——
 * 封面是世界的，跟某一个角色无关；跨角色、跨世界的图都可能被拿来当封面。
 */
async function toggleRecent() {
  if (coverBusy.value) return
  recentOpen.value = !recentOpen.value
  if (!recentOpen.value || recentImages.value.length) return
  recentLoading.value = true
  try {
    const r = await api.getRecentGeneratedImages(40)
    recentImages.value = r?.images || []
  } catch (err) {
    toastFn?.('读取近期图片失败：' + (err?.message || ''), 'error')
  } finally {
    recentLoading.value = false
  }
}

/** 选一张近期图当封面。存的是服务器上已有的 URL，不走 base64 上传。 */
async function applyRecentCover(url) {
  if (coverBusy.value || !url) return
  coverBusy.value = true
  try {
    await api.updateWorldSetting(worldId.value, { cover_image: url })
    if (world.value) world.value.cover_image = url
    emit('changed')
    toastFn?.('封面已换成这张', 'success')
    recentOpen.value = false
  } catch (err) {
    toastFn?.('设置失败：' + (err?.message || ''), 'error')
  } finally {
    coverBusy.value = false
  }
}

/** AI 按世界观画封面（后端固定 1216×832） */
async function generateCover() {
  if (coverBusy.value) return
  coverBusy.value = true
  coverPrompt.value = ''
  coverStage.value = '正在读世界观…'
  try {
    const r = await api.generateWorldCover(
      worldId.value,
      { extra: coverExtra.value.trim() },
      {
        onPrompt: (d) => {
          coverPrompt.value = d.prompt || ''
          if (d.note) toastFn?.(d.note, 'error')
          // LLM 不通时后端会用规则拼装，这里说清楚，免得用户以为 AI 变笨了
          if (d.source === 'fallback') toastFn?.('大模型没接上，按已有字段拼了个简易提示词', 'error')
        },
        onStage: (s) => {
          if (s === 'prompting') coverStage.value = '正在读世界观…'
          else if (s === 'generating') coverStage.value = '正在画（本地出图，约 1 分钟）…'
        },
      },
    )
    if (world.value && r.cover_image) world.value.cover_image = r.cover_image
    emit('changed')
    toastFn?.('封面已生成', 'success')
  } catch (err) {
    toastFn?.('生成失败：' + (err?.message || ''), 'error')
  } finally {
    coverBusy.value = false
    coverStage.value = ''
  }
}

/** 读文件 → 等比压到 ≤1600px → JPEG 0.85（原图几 MB，卡面只要几百 KB） */
function compressImage(file, maxW = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('这张图片打不开'))
      img.onload = () => {
        const scale = Math.min(1, maxW / (img.width || maxW))
        const w = Math.max(1, Math.round((img.width || maxW) * scale))
        const h = Math.max(1, Math.round((img.height || maxW) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

async function onCoverPicked(e) {
  const file = e?.target?.files?.[0]
  if (e?.target) e.target.value = ''   // 允许重复选同一张
  if (!file) return
  coverBusy.value = true
  try {
    const base64 = await compressImage(file)
    const r = await api.uploadWorldCover(worldId.value, base64)
    if (world.value) world.value.cover_image = r?.cover_image || ''
    emit('changed')
    coverOpen.value = false
    toastFn?.('封面已更新', 'success')
  } catch (err) {
    toastFn?.('封面上传失败：' + (err?.message || ''), 'error')
  } finally {
    coverBusy.value = false
  }
}

async function clearCover() {
  coverBusy.value = true
  try {
    await api.updateWorldSetting(worldId.value, { cover_image: '' })
    if (world.value) world.value.cover_image = ''
    emit('changed')
    toastFn?.('已清除封面', 'success')
  } catch (err) {
    toastFn?.('清除失败：' + (err?.message || ''), 'error')
  } finally {
    coverBusy.value = false
  }
}

async function removeWorld() {
  // ★ 2026-10-18：主世界是骨架层，删了所有角色就没公共规则了（后端也拦）
  if (world.value?.is_core) {
    toastFn?.('这是主世界（骨架层），不能删除。先把别的世界设为主世界，再回来删它', 'error')
    return
  }
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
    emit('removed')
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

// 嵌入模式下切换世界不重挂载 → 必须自己跟着 worldId 重载
watch(worldId, (id, prev) => {
  if (!props.embedded || !id || id === prev) return
  dirty.value = false
  load()
})
</script>

<style scoped>
.smd-page {
  max-width: 980px;
  margin: 0 auto;
  padding: 18px 20px 48px;
  box-sizing: border-box;
}
/* 嵌入在星图右栏时：父级已经给了边距，自己不再撑 max-width / padding */
.smd-page.is-embedded {
  max-width: none;
  margin: 0;
  padding: 0;
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
  background: var(--card-badge-bg);
  color: var(--card-badge-ink);
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
  /* 可翻转纸面：暖色与旧观感一致，暗夜转深色纸（见 tokens.css --card-* 说明） */
  background: var(--card-paper);
  color: var(--card-ink);
  border: 1.5px solid var(--card-line);
  border-radius: 16px;
  padding: 14px;
  box-shadow: var(--shadow-xs);
}
/* 纸内输入框跟随纸色 —— 不在纸上再套一个白框（避免"卡片套卡片"的观感） */
.smd-paper :deep(.ls-input) {
  background: var(--card-paper-raised);
  border-color: var(--card-line);
  color: var(--card-ink);
  --ls-input-focus-color: var(--accent);
}
.smd-paper :deep(.ls-input::placeholder) { color: var(--card-ink-muted); }

.smd-textarea { width: 100%; }
.smd-paper-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
}
/* 纸面强调小字：用主题强调色（亮色/暗夜各自已达标，写死会在另一套主题上掉到 3.x） */
.smd-dirty { font-size: 12px; color: var(--accent); margin-right: auto; }

.smd-fields { display: flex; flex-direction: column; gap: 12px; }
.smd-field { display: flex; flex-direction: column; gap: 6px; }
.smd-field-label { font-size: 13px; color: var(--text-secondary); }
.smd-optional { font-size: 11px; color: var(--text-secondary); }

.smd-list { display: flex; flex-direction: column; gap: 8px; }

/* ── 地图页签：地点铺出来 + 地点头像 ───────────────────── */
.smd-map-block {
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 14px;
  background: var(--bg-secondary);
}
.smd-map-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.smd-map-name { font-size: 14px; font-weight: 500; color: var(--text-bright); }
.smd-map-count { font-size: 11.5px; color: var(--text-secondary); }
.smd-map-open { margin-left: auto; }
.smd-map-empty { padding: 2px 0; }

.smd-tree { display: flex; flex-direction: column; gap: 6px; }

/* 节点=一行。大地区/子地区/场景共用这套骨架，只靠底色与缩进区分层级 —— */
/* 用三套不同的方框色反而更乱（实测旧版大小地区混在网格里分不清谁属于谁）。 */
.smd-node {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 5px 10px;
  border-radius: 9px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard);
}
.smd-node.is-leaf { cursor: default; }
.smd-node:not(.is-leaf):hover { border-color: var(--accent); }
.smd-node:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.smd-caret {
  flex: none;
  width: 11px;
  font-size: 10px;
  line-height: 1;
  color: var(--text-secondary);
  text-align: center;
}
.smd-node-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.smd-node-badge {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.smd-node-badge.is-poi { background: transparent; border: 1px solid var(--border); }
.smd-node-people { margin-left: auto; display: flex; align-items: center; flex: none; }

/* 大地区：整行一条，底色提一档当"分区标题" */
.smd-branch.is-l1 > .smd-node {
  background: var(--bg-tertiary);
  border-color: var(--border-strong);
  min-height: 36px;
}
.smd-branch.is-l1 > .smd-node .smd-node-name { font-size: 13px; font-weight: 500; color: var(--text-bright); }
/* 子地区：透明 + 虚线，弱一档 */
.smd-branch.is-l2 > .smd-node { background: transparent; border-style: dashed; }

/* 缩进 = 层级。左侧那条虚线是"这属于上面那一项"的视觉线索 */
.smd-kids {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 5px 0 2px 16px;
  padding-left: 8px;
  border-left: 1px dashed var(--border);
}

/* 场景与生活地点：压成文字行，不再做成方块（三层方块叠起来视觉噪音太大） */
.smd-leaf-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 6px 0 2px 16px;
  padding-left: 8px;
  border-left: 1px dashed var(--border);
}
.smd-leaf { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.smd-leaf-name { font-size: 12px; color: var(--text-primary); }
.smd-poi {
  font-size: 10.5px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.smd-leaf-empty { margin: 2px 0; font-size: 11px; color: var(--text-secondary); }
.smd-place-ava {
  width: 22px; height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #fff;
  background: #8a6550 center/cover no-repeat;
  /* 与卡片底色同色描边，叠起来才有"叠"的层次 */
  border: 2px solid var(--bg-secondary);
  box-sizing: content-box;
  overflow: hidden;
}
.smd-place-ava + .smd-place-ava { margin-left: -6px; }
.smd-place-ava.is-more { background: var(--bg-hover); color: var(--text-secondary); }

.smd-map-unplaced { margin: 10px 0 0; font-size: 11.5px; color: var(--text-secondary); line-height: 1.7; }
.smd-map-unplaced-label { margin-right: 4px; }
.smd-map-unplaced-item { display: inline-flex; align-items: center; gap: 5px; margin-right: 12px; }
/* 这里的小头像跟在文字前面，不需要"叠"的负边距与纸色描边 */
.smd-map-unplaced-item .smd-place-ava { width: 18px; height: 18px; border-width: 0; font-size: 9px; }.smd-row {
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
  background: var(--card-paper-raised);
  color: var(--card-ink-muted);
  flex: none;
  overflow: hidden;
  box-sizing: border-box;
}
/* 有头像时：铺图 + 一圈细描边（透明头像压在白底上会"糊掉"） */
.smd-avatar.has-img {
  background-size: cover;
  background-position: center;
  border: 1px solid var(--border);
}
.smd-hint { font-size: 12.5px; color: var(--text-secondary); padding: 8px 2px; }
/* 移动型世界（载具）开关：它改的是"日程从哪取地点"，值得单独占一行讲清楚 */
.smd-vehicle-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}
.smd-vehicle-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.smd-vehicle-title { font-size: 12.5px; font-weight: 500; color: var(--text-primary); }
.smd-vehicle-sub { font-size: 11.5px; line-height: 1.6; color: var(--text-secondary); }
/* 主世界（骨架）的说明条：告诉使用者"这里不是地方，是通则"，顺便解释为什么只有一个页签 */
.smd-core-note {
  margin: 2px 2px 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-left: 3px solid color-mix(in srgb, var(--accent) 70%, var(--border));
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary);
}
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

/* 封面弹窗 */
.smd-cover-form { display: flex; flex-direction: column; gap: 12px; }
.smd-cover-preview {
  position: relative;
  width: 100%;
  /* 与 AI 出图的实际比例一致（1216×832），预览什么样、卡上就什么样 */
  aspect-ratio: 1216 / 832;
  border-radius: 12px;
  background: var(--bg-secondary) center/cover no-repeat;
  border: 1px solid var(--border);
}
/* 生成中：盖一层半透明底 + 阶段文案，避免"点了没反应"的错觉 */
.smd-cover-veil {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgba(22, 19, 26, 0.62);
  color: #fff;
  font-size: 13px;
  letter-spacing: .02em;
}
.smd-cover-file { display: none; }
.smd-cover-actions { display: flex; gap: 10px; flex-wrap: wrap; }

/* 「近期生成」缩略图墙：和角色头像选择器同一视觉语言（正方形、轻描边、选中描强调色） */
.smd-recent {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
.smd-recent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
  gap: 8px;
  max-height: 236px;
  overflow-y: auto;
  padding: 2px;
}
.smd-recent-item {
  aspect-ratio: 1 / 1;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-sunken) center/cover no-repeat;
  cursor: pointer;
  padding: 0;
  transition: transform var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}
.smd-recent-item:hover { transform: translateY(-1px); border-color: var(--accent); }
.smd-recent-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.smd-recent-item.is-picked {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}
.smd-recent-item:disabled { opacity: .55; cursor: default; }

/* 提示词回显：让用户看得见 AI 到底要画什么（也方便自己改写后重试） */
.smd-cover-prompt {
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
}
.smd-cover-prompt-label { font-size: 11px; color: var(--text-secondary); }
.smd-cover-prompt-text {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
}

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
