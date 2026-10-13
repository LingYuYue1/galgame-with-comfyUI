<template>
  <section ref="stage" class="gal-stage" :class="{ 'is-paused': !active || documentHidden, 'has-photos': currentImages.length > 0 }" :style="viewportStyle" aria-label="沉浸对话" tabindex="-1" @keydown="onKeydown" @click.self="restoreDialogue">
    <Transition name="gal-fade">
      <div :key="backgroundUrl" class="gal-backdrop" :style="backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : {}" @click="restoreDialogue"></div>
    </Transition>
    <div class="gal-actor" :style="{ width: `${geometry.width}px`, height: `${geometry.height}px` }" @click="restoreDialogue">
      <div class="gal-breath">
        <Transition name="gal-expression">
          <div v-if="standing?.imageUrl" :key="standing.imageUrl" class="gal-portrait">
            <img :src="standing.imageUrl" :style="geometry.image" :alt="`${character.display_name}的立绘`" draggable="false">
          </div>
        </Transition>
      </div>
    </div>

    <nav class="gal-toolbar" aria-label="舞台操作" :inert="historyPresent || undefined">
      <div class="gal-tool" role="button" tabindex="0" aria-label="历史回顾" @click="openHistory" @keydown.enter.stop.prevent="openHistory" @keydown.space.stop.prevent="openHistory">
        <GalgameMenuFrame />
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v15M3 4c3-1 6 0 9 2 3-2 6-3 9-2v15c-3-1-6 0-9 2-3-2-6-3-9-2Z" /><path d="m6 8 3 1m-3 3 3 1m6-4 3-1m-3 5 3-1" /></svg>
        <span>回顾</span>
      </div>
      <div class="gal-toolbar-right">
        <div class="gal-tool gal-standing-entry" role="button" tabindex="0" aria-label="同步立绘展示" title="在独立窗口展示立绘，随当前聊天同步角色与表情" @click="$emit('open-standing')" @keydown.enter.stop.prevent="$emit('open-standing')" @keydown.space.stop.prevent="$emit('open-standing')">
          <GalgameMenuFrame />
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="15" rx="3" /><path d="M8 22h8M12 18v4" /><circle cx="12" cy="8" r="2" /><path d="M8 15a4 4 0 0 1 8 0" /></svg>
          <span>同步立绘</span>
        </div>
        <div class="gal-tool" role="button" tabindex="0" :aria-label="dialogueHidden ? '显示对话' : '隐藏对话'" :aria-pressed="dialogueHidden" @click="dialogueHidden = !dialogueHidden" @keydown.enter.stop.prevent="dialogueHidden = !dialogueHidden" @keydown.space.stop.prevent="dialogueHidden = !dialogueHidden">
          <GalgameMenuFrame />
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path v-if="dialogueHidden" d="m3 3 18 18" /></svg>
          <span>{{ dialogueHidden ? '显示' : '隐藏' }}</span>
        </div>
        <div class="gal-tool" role="button" tabindex="0" aria-label="返回聊天" @click="$emit('exit')" @keydown.enter.stop.prevent="$emit('exit')" @keydown.space.stop.prevent="$emit('exit')">
          <GalgameMenuFrame />
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16" /></svg>
          <span>返回聊天</span>
        </div>
      </div>
    </nav>

    <Transition name="gal-fade">
      <div v-if="!dialogueHidden" class="gal-interface" :inert="historyPresent || undefined">
        <Transition name="gal-fade" mode="out-in">
          <div v-if="currentImages.length" :key="currentId" class="gal-photos" aria-label="当前回复的图片">
            <div v-for="(url, index) in currentImages" :key="url" class="gal-photo" role="button" tabindex="0" :aria-label="`查看回复图片 ${index + 1}`" @click="openImages(currentImages, index)" @keydown.enter.stop.prevent="openImages(currentImages, index)" @keydown.space.stop.prevent="openImages(currentImages, index)">
              <GalgamePhoto :src="url" :alt="`回复图片 ${index + 1}`" />
            </div>
          </div>
        </Transition>
        <Transition name="gal-fade" mode="out-in">
          <div v-if="!assetsReady" key="missing" class="gal-choices gal-missing" aria-label="登场准备">
            <p role="status">{{ assetsLoading ? '正在检查登场素材…' : assetNotice }}</p>
            <TownVnChoice v-if="!standing?.imageUrl || standingError" variant="dialogue" :disabled="standingLoading" @select="managerOpen = true">打开当前角色立绘管理</TownVnChoice>
            <TownVnChoice v-if="emojisChecked && (!emojisAvailable || emojisError)" variant="dialogue" @select="emojiManagerOpen = true">打开当前角色表情包管理</TownVnChoice>
            <TownVnChoice variant="dialogue" :busy="assetsLoading" @select="refreshAssets">重新检查</TownVnChoice>
          </div>
          <div v-else-if="showChoices" key="choices" class="gal-choices" :style="{ '--gal-choice-height': `${choiceHeight}px` }" aria-label="选择你的回应">
            <div v-if="choices.length || choiceStatus" ref="suggestionList" class="gal-suggestions">
              <p v-if="choiceStatus" class="gal-choice-status" role="status">{{ choiceStatus }}</p>
              <TownVnChoice v-for="choice in choices" :key="choice" data-gal-option variant="dialogue" :disabled="sendBusy" @select="send(choice)">{{ choice }}</TownVnChoice>
            </div>
            <div class="gal-composer" :class="{ 'is-disabled': sendBusy }" role="group" aria-label="自由回应">
              <GalgameMenuFrame />
              <svg class="gal-composer-pen" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z" /><path d="m4 14 5 5" /></svg>
              <input class="gal-reply-input" :value="draft" type="text" aria-label="你想说的话" autocomplete="off" enterkeyhint="send" :disabled="sendBusy" @input="$emit('update:draft', $event.target.value)" @keydown.enter.exact="submitOnEnter">
              <div class="gal-send" :class="{ 'is-disabled': !draft.trim() || sendBusy }" role="button" :tabindex="!draft.trim() || sendBusy ? -1 : 0" aria-label="发送回应" :aria-disabled="!draft.trim() || sendBusy" :aria-busy="sendBusy" @click="send(draft)" @keydown.enter.stop.prevent="send(draft)" @keydown.space.stop.prevent="send(draft)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 5 7 7-7 7M4 12h16" /></svg>
                <span>发送</span>
              </div>
            </div>
          </div>
        </Transition>

        <div class="gal-dialogue">
          <svg class="gal-frame" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">
            <path class="gal-frame-paper" d="M68 5 H932 Q950 5 960 24 L990 82 Q996 94 996 110 V170 Q996 184 987 197 L958 239 Q948 254 930 254 H69 Q48 254 37 238 L12 198 Q4 186 4 170 V109 Q4 94 12 80 L43 25 Q53 5 68 5 Z" />
            <path class="gal-frame-inner" d="M71 12 H929 Q943 12 952 28 L981 84 Q988 97 988 112 V168 Q988 181 980 192 L950 234 Q942 246 927 246 H72 Q53 246 44 231 L20 194 Q12 182 12 168 V110 Q12 97 20 85 L51 29 Q59 12 71 12 Z" />
          </svg>
          <div class="gal-heading">
            <strong :title="character.display_name">{{ currentMessage?.role === 'user' ? '我' : character.display_name }}</strong>
            <div class="gal-heading-actions">
              <span v-if="pages.length > 1" class="gal-page-count">{{ pageIndex + 1 }} / {{ pages.length }}</span>
              <Transition name="gal-fade">
                <div v-if="sleeping" class="gal-wake" :class="{ 'is-busy': wakeBusy }" role="button" :tabindex="wakeBusy ? -1 : 0" :aria-label="`叫醒${character.display_name}`" :aria-disabled="wakeBusy || undefined" :aria-busy="wakeBusy || undefined" @click="wake" @keydown.enter.stop.prevent="wake" @keydown.space.stop.prevent="wake">
                  <GalgameMenuFrame />
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.3A8.4 8.4 0 0 1 9.7 4a8.5 8.5 0 1 0 10.3 10.3Z" /><path d="M16 3v4m-2-2h4" /></svg>
                  <span>{{ wakeBusy ? '正在呼唤…' : '睡着了 · 叫醒' }}</span>
                </div>
              </Transition>
            </div>
          </div>
          <div ref="textArea" class="gal-text" :class="{ 'can-advance': canAdvance }" :role="canAdvance ? 'button' : undefined" :tabindex="canAdvance ? 0 : undefined" :aria-label="canAdvance ? advanceLabel : undefined" :aria-description="canAdvance ? pages[pageIndex] : undefined" @click="advance" @keydown.enter.stop.prevent="advance" @keydown.space.stop.prevent="advance">
            <p v-if="!assetsReady" class="gal-empty">立绘与表情包准备好后，就可以开始对话。</p>
            <p v-else-if="currentMessage" class="gal-line"><span>{{ revealedText }}</span><span class="gal-unrevealed" aria-hidden="true">{{ unrevealedText }}</span></p>
            <p v-else-if="!loading && !sendBusy && !queued" class="gal-empty">故事从你的第一句话开始。</p>
          </div>
          <div class="gal-footer">
            <span v-if="error || sendError" class="gal-error" role="alert">{{ error || sendError }} <linshe-button v-if="error" variant="link" size="sm" @click="refresh">重试</linshe-button></span>
            <span v-else-if="waitStatus" role="status">{{ waitStatus }}</span>
            <span v-else-if="assetsReady">{{ advanceLabel }}</span>
            <div v-if="assetsReady && (typing || hasNext)" class="gal-next" role="button" tabindex="0" :aria-label="advanceLabel" @click="advance" @keydown.enter.stop.prevent="advance" @keydown.space.stop.prevent="advance">▾</div>
          </div>
        </div>
      </div>
    </Transition>

    <GalgameHistory v-model:open="historyOpen" :character-name="character.display_name" :messages="messages" :has-older="hasOlder" :loading="loading" :loading-older="loadingOlder" :load-older="loadOlder" :error="error" :suspended="lightboxOpen" @present-change="historyPresent = $event" @preview-images="openImages" @retry="refresh" />
    <EmojiManagerModal v-if="emojiManagerOpen" :key="character.id" :characters="[character]" @close="closeEmojiManager" />
    <ExpressionStandingManager :open="managerOpen" :character="character" @close="closeManager" />
    <Teleport to="body">
      <div style="--vel-z-index: 14000">
        <ImageLightbox :visible="lightboxOpen" :imgs="lightboxImages" :index="lightboxIndex" :show-regenerate="false" :show-upscale="false" :show-delete="false" @hide="lightboxOpen = false" />
      </div>
    </Teleport>
  </section>
</template>

<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import GalgameHistory from './GalgameHistory.vue'
import GalgamePhoto from './GalgamePhoto.vue'
import GalgameMenuFrame from './GalgameMenuFrame.vue'
import TownVnChoice from '../town/TownVnChoice.vue'
import ExpressionStandingManager from '../ExpressionStandingManager.vue'
import EmojiManagerModal from '../EmojiManagerModal.vue'
import ImageLightbox from '../ImageLightbox.vue'
import { useChatStore } from '../../stores/chat.js'
import { onEvent } from '../../stores/unifiedStream.js'
import { useGalgameTranscript } from '../../composables/useGalgameTranscript.js'
import { useDialogueStanding } from '../../composables/useDialogueStanding.js'
import { useDialogueEmojis } from '../../composables/useDialogueEmojis.js'
import { standingGeometry } from '../../utils/standingGeometry.js'
import { dialogueCharacters, dialogueCharacterDelay, repaginateDialogue, dialogueWaitStatus } from '../../utils/galgameDialogue.js'

const props = defineProps({ character: { type: Object, required: true }, active: Boolean, draft: { type: String, default: '' }, imageMode: { type: String, default: 'smart' }, deepThink: Boolean, sleeping: Boolean, wakeBusy: Boolean })
const emit = defineEmits(['exit', 'update:draft', 'open-standing', 'wake'])
const chat = useChatStore()
const stage = ref(null), textArea = ref(null)
const historyOpen = ref(false), historyPresent = ref(false), managerOpen = ref(false), dialogueHidden = ref(false)
const emojiManagerOpen = ref(false)
const lightboxOpen = ref(false), lightboxImages = ref([]), lightboxIndex = ref(0)
const backgroundUrl = computed(() => props.character.galgame_bg_path || props.character.chat_bg_path || '')
const suggestionList = ref(null), choiceHeight = ref(46)
const documentHidden = ref(document.hidden), reducedMotion = ref(false)
const paused = computed(() => !assetsReady.value || emojiManagerOpen.value || !props.active || documentHidden.value || historyOpen.value || historyPresent.value || managerOpen.value || dialogueHidden.value || lightboxOpen.value)
const { messages, loading, loadingOlder, error, hasOlder, latestId, latestRole, refresh, loadOlder } = useGalgameTranscript(() => props.character.id)
const { shown: standing, error: standingError, loading: standingLoading, refresh: refreshStanding } = useDialogueStanding(() => props.character.id, () => props.active)
const { available: emojisAvailable, checked: emojisChecked, loading: emojisLoading, error: emojisError, refresh: refreshEmojis } = useDialogueEmojis(() => props.character.id, () => props.active)
const assetsReady = computed(() => Boolean(standing.value?.imageUrl) && !standingError.value && emojisAvailable.value && !emojisError.value)
const assetsLoading = computed(() => standingLoading.value || emojisLoading.value || !emojisChecked.value)
const assetNotice = computed(() => {
  if (standingError.value || emojisError.value) return [standingError.value, emojisError.value].filter(Boolean).join('；')
  const missing = [!standing.value?.imageUrl && '默认立绘', !emojisAvailable.value && '已启用的表情包'].filter(Boolean)
  return `还缺少${missing.join('和')}，准备好后再开始对话吧。`
})
function refreshAssets() { return Promise.all([refreshStanding(), refreshEmojis()]) }
function closeEmojiManager() { emojiManagerOpen.value = false; refreshAssets() }
const size = ref({ width: 1000, height: 700 }), viewportStyle = ref({})
const geometry = computed(() => standingGeometry(standing.value?.bounds, size.value.width * (size.value.width < 600 ? .95 : .72), size.value.height * .94, { horizontal: 0, vertical: 0 }))
const currentId = ref(null), pageIndex = ref(0), pages = ref(['']), revealed = ref(0), paginationSourceId = ref(null)
const playable = computed(() => messages.value.filter(message => (message.content || message.images?.length) && message.role === 'assistant'))
const currentMessage = computed(() => playable.value.find(message => message.id === currentId.value))
const currentImages = computed(() => currentMessage.value?.images || [])
const dialogueContent = computed(() => currentMessage.value?.content || (currentImages.value.length ? `（发来了 ${currentImages.value.length} 张图片）` : ''))
const pageCharacters = computed(() => dialogueCharacters(pages.value[pageIndex.value] || ''))
const revealedText = computed(() => pageCharacters.value.slice(0, revealed.value).join(''))
const unrevealedText = computed(() => pageCharacters.value.slice(revealed.value).join(''))
const typing = computed(() => revealed.value < pageCharacters.value.length)
const hasNextPage = computed(() => pageIndex.value < pages.value.length - 1)
const hasNext = computed(() => hasNextPage.value || playable.value.some(message => message.id > currentId.value))
const advanceLabel = computed(() => typing.value ? '点击显示全文' : hasNextPage.value ? '点击继续' : hasNext.value ? '点击查看新回复' : '')
const canAdvance = computed(() => assetsReady.value && (typing.value || hasNext.value))
const caughtUp = computed(() => !typing.value && !hasNext.value)
const queued = computed(() => chat.queuedReplies[props.character.id])
const localSending = ref(false), sendError = ref('')
const sendBusy = computed(() => localSending.value || chat.streaming)
const waitStatus = computed(() => dialogueWaitStatus(chat))
const showChoices = computed(() => assetsReady.value && caughtUp.value && (!currentMessage.value || paginationSourceId.value === currentId.value) && !loading.value && !error.value && !queued.value)
const choices = computed(() => {
  if (latestRole.value !== 'assistant' || currentId.value !== latestId.value) return []
  // 只复用当前聊天已返回的候选；为空时不额外请求生成。
  const data = chat.guessSourceRawId === latestId.value ? chat.guesses : null
  return [...new Set([data?.a, data?.b].filter(value => typeof value === 'string' && value.trim()))].slice(0, 2)
})
const choiceStatus = computed(() => waitStatus.value)
let typeTimer, refreshTimer, pollTimer, resizeObserver, textObserver, choiceObserver, disposed = false
let awaitingAfter = null
const canvas = document.createElement('canvas'), context = canvas.getContext('2d')

function paginate(reset = false) {
  if (!currentMessage.value) { pages.value = ['']; pageIndex.value = 0; revealed.value = 0; paginationSourceId.value = null; clearTimeout(typeTimer); return }
  if (!textArea.value || !props.active) return
  const el = textArea.value, style = getComputedStyle(el)
  context.font = style.font
  const next = repaginateDialogue(dialogueContent.value, {
    width: Math.max(80, el.clientWidth - 2), lines: Math.max(1, Math.floor(el.clientHeight / parseFloat(style.lineHeight))),
    measure: char => context.measureText(char).width,
  }, { pages: pages.value, pageIndex: pageIndex.value, revealed: revealed.value }, reset || paginationSourceId.value !== currentId.value)
  pages.value = next.pages
  pageIndex.value = next.pageIndex
  revealed.value = next.revealed
  paginationSourceId.value = currentId.value
  startTyping()
}
function startTyping() {
  clearTimeout(typeTimer)
  if (paused.value || !typing.value) return
  if (reducedMotion.value) { revealed.value = pageCharacters.value.length; return }
  typeTimer = setTimeout(() => { revealed.value++; startTyping() }, dialogueCharacterDelay(pageCharacters.value[revealed.value - 1] || ''))
}
function advance() {
  if (paused.value || !currentMessage.value) return
  if (typing.value) { clearTimeout(typeTimer); revealed.value = pageCharacters.value.length; return }
  if (pageIndex.value < pages.value.length - 1) { pageIndex.value++; revealed.value = 0; startTyping(); return }
  const next = playable.value.find(message => message.id > currentId.value)
  if (next) currentId.value = next.id
}
function restoreDialogue() { if (dialogueHidden.value) dialogueHidden.value = false }
function wake() { if (props.active && props.sleeping && !props.wakeBusy) emit('wake') }
function openImages(images, index) {
  lightboxImages.value = images; lightboxIndex.value = index; lightboxOpen.value = true
}
function onKeydown(event) {
  if (event.isComposing || event.target.closest('textarea, input, button, [role="button"]')) return
  if (event.key === 'Escape') {
    if (historyOpen.value || managerOpen.value || emojiManagerOpen.value || lightboxOpen.value) return
    if (dialogueHidden.value) dialogueHidden.value = false
    else emit('exit')
    event.preventDefault(); event.stopPropagation()
  } else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (dialogueHidden.value) restoreDialogue(); else advance() }
}
function openHistory() { historyOpen.value = true }
function closeManager() { managerOpen.value = false; refreshAssets() }
function submitOnEnter(event) { if (!event.isComposing && event.keyCode !== 229) { event.preventDefault(); send(props.draft) } }
async function send(value) {
  const text = value.trim()
  if (!text || sendBusy.value || !props.active || !assetsReady.value) return
  const characterId = props.character.id
  localSending.value = true; sendError.value = ''; awaitingAfter = latestId.value || 0
  const sentDraft = props.draft
  emit('update:draft', '')
  try {
    await chat.sendMessage(text, props.imageMode, props.deepThink, { galgameMode: true })
    if (disposed || props.character.id !== characterId) return
    if (chat.lastSendError) {
      sendError.value = chat.lastSendError
      if (!chat.responseComplete) emit('update:draft', sentDraft || text)
    }
  }
  catch (cause) { if (!disposed && props.character.id === characterId) { sendError.value = cause.message || '发送失败，请重试'; emit('update:draft', sentDraft || text) } }
  finally { if (!disposed && props.character.id === characterId) { localSending.value = false; refresh() } }
}
function scheduleRefresh() { if (!props.active) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 100) }
function resize() {
  if (!props.active || !stage.value) return
  const viewport = window.visualViewport
  const parentTop = stage.value.parentElement.getBoundingClientRect().top
  const visibleTop = Math.max(parentTop, viewport?.offsetTop || 0)
  viewportStyle.value = viewport ? { top: `${visibleTop - parentTop}px`, height: `${Math.max(0, viewport.offsetTop + viewport.height - visibleTop)}px` } : {}
  size.value = { width: stage.value.clientWidth, height: stage.value.clientHeight }
  paginate()
}
function visibility() { documentHidden.value = document.hidden; if (!document.hidden && props.active) { refresh(); refreshAssets() } }

watch(() => props.character.id, () => {
  currentId.value = null; pages.value = ['']; revealed.value = 0; pageIndex.value = 0
  awaitingAfter = null; historyOpen.value = false; managerOpen.value = false; emojiManagerOpen.value = false; localSending.value = false; sendError.value = ''
  lightboxOpen.value = false; lightboxImages.value = []
}, { flush: 'sync' })
watch(playable, rows => {
  if (!rows.some(row => row.id === currentId.value)) currentId.value = rows.at(-1)?.id || null
  if (awaitingAfter !== null) {
    const reply = rows.find(row => row.id > awaitingAfter)
    if (reply) { currentId.value = reply.id; awaitingAfter = null }
  }
})
watch(() => dialogueContent.value + ':' + currentId.value, async () => { await nextTick(); paginate(true) })
watch(paused, startTyping)
watch(textArea, el => { textObserver?.disconnect(); if (el) { textObserver = new ResizeObserver(() => paginate()); textObserver.observe(el); paginate() } })
watch([suggestionList, choices], async () => {
  await nextTick(); if (disposed) return
  choiceObserver?.disconnect()
  const options = [...(suggestionList.value?.querySelectorAll('[data-gal-option]') || [])]
  const measure = () => { choiceHeight.value = Math.max(46, ...options.map(el => el.getBoundingClientRect().height)) }
  choiceObserver = new ResizeObserver(measure)
  options.forEach(el => choiceObserver.observe(el)); measure()
}, { flush: 'post' })
watch([() => props.active, () => props.character.id], async ([active]) => { if (active) { refresh(); await nextTick(); resize(); stage.value?.focus({ preventScroll: true }); startTyping() } else { historyOpen.value = false; managerOpen.value = false; emojiManagerOpen.value = false; lightboxOpen.value = false } }, { immediate: true })
watch([() => chat.dialogueRevision, () => chat.streaming, () => chat.messages.length], scheduleRefresh)
const offs = ['connected', 'proactive_message', 'delayed_reply', 'reply_ready'].map(name => onEvent(name, scheduleRefresh))
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
function updateMotion() { reducedMotion.value = motionQuery.matches; startTyping() }
onMounted(() => {
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage.value)
  window.visualViewport?.addEventListener('resize', resize)
  window.visualViewport?.addEventListener('scroll', resize)
  document.addEventListener('visibilitychange', visibility)
  motionQuery.addEventListener('change', updateMotion); updateMotion()
  pollTimer = setInterval(() => { if (props.active && !document.hidden) { refresh(); refreshAssets() } }, 15000)
  document.fonts?.ready.then(() => { if (!disposed) paginate() })
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(typeTimer); clearTimeout(refreshTimer); clearInterval(pollTimer)
  resizeObserver?.disconnect(); textObserver?.disconnect(); choiceObserver?.disconnect(); offs.forEach(off => off())
  window.visualViewport?.removeEventListener('resize', resize)
  window.visualViewport?.removeEventListener('scroll', resize)
  document.removeEventListener('visibilitychange', visibility); motionQuery.removeEventListener('change', updateMotion)
})
</script>

<style scoped>
.gal-stage { --gal-dialogue-height: clamp(200px, 28dvh, 290px); --gal-bottom: max(24px, env(safe-area-inset-bottom)); position: absolute; inset: 0; overflow: clip; isolation: isolate; container-type: inline-size; background: var(--bg-primary); color: var(--dialogue-ink); outline: none; }
.gal-backdrop { position: absolute; inset: 0; background-size: cover; background-position: center; background-color: var(--bg-sunken); }
.gal-actor { position: absolute; left: 50%; bottom: -3%; transform: translateX(-50%); z-index: 1; pointer-events: auto; }
.gal-breath { width: 100%; height: 100%; transform-origin: center bottom; animation: gal-breath 4.5s ease-in-out infinite; }
.gal-portrait { position: absolute; inset: 0; overflow: hidden; }
.gal-portrait img { position: absolute; max-width: none; user-select: none; }
.gal-toolbar { position: absolute; top: max(20px, env(safe-area-inset-top)); left: max(28px, env(safe-area-inset-left)); right: max(28px, env(safe-area-inset-right)); display: flex; justify-content: space-between; align-items: center; gap: 12px; z-index: 5; }
.gal-toolbar-right { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.gal-tool { position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 8px 18px; border-radius: 2px; color: var(--dialogue-menu-text); font-size: var(--fs-md); font-weight: 800; letter-spacing: .08em; text-align: center; white-space: nowrap; cursor: pointer; user-select: none; transition: color var(--dur-interaction) var(--ease-standard), transform var(--dur-interaction) var(--ease-standard), opacity var(--dur-interaction) var(--ease-standard); }
.gal-tool > svg:not(.gal-menu-frame), .gal-composer svg { width: 22px; height: 22px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.gal-tool > svg:not(.gal-menu-frame) { stroke-width: 2.1; }
.gal-tool::after { content: ''; position: absolute; bottom: 8px; left: 47px; right: 18px; height: 2px; background: var(--dialogue-menu-accent); opacity: 0; transform: scaleX(.6); transform-origin: left center; transition: color var(--dur-interaction) var(--ease-standard), opacity var(--dur-interaction) var(--ease-standard), transform var(--dur-interaction) var(--ease-standard); }
.gal-tool:hover, .gal-tool:focus-visible { transform: translateY(-2px); }
.gal-tool:hover::after, .gal-tool:focus-visible::after { opacity: .7; transform: scaleX(1); }
.gal-tool:active { transform: translateY(1px); }
.gal-tool[aria-pressed="true"] { --gal-menu-outline: var(--dialogue-menu-text); }
.gal-tool[aria-pressed="true"]::after { opacity: .7; transform: scaleX(1); }
.gal-tool:focus-visible { outline: 2px solid var(--dialogue-menu-text); outline-offset: 4px; }
.gal-tool:is(:hover, :focus-visible), .gal-wake:is(:hover, :focus-visible):not(.is-busy), .gal-send:is(:hover, :focus-visible):not(.is-disabled) { --dialogue-menu-text: var(--dialogue-menu-hover); --gal-menu-outline: var(--dialogue-menu-hover); }
.gal-send:focus-visible { outline: 2px solid var(--dialogue-menu-text); outline-offset: 2px; }
.gal-interface { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.gal-photos { position: absolute; left: 5%; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 22px); width: min(480px, 38%); max-height: calc(100% - var(--gal-dialogue-height) - var(--gal-bottom) - 90px); display: flex; flex-direction: column; gap: 14px; padding: 8px 10px 14px; overflow-y: auto; pointer-events: auto; }
.gal-photo { --gal-photo-max-height: min(380px, calc(100dvh - var(--gal-dialogue-height) - var(--gal-bottom) - 130px)); flex-shrink: 0; padding: 8px; border: 0; border-radius: 0; background: var(--dialogue-photo-paper); box-shadow: var(--dialogue-photo-shadow); cursor: zoom-in; text-align: center; }
.gal-dialogue { --dialogue-ink: var(--dialogue-speech-ink); --dialogue-muted: var(--dialogue-speech-muted); color: var(--dialogue-ink); position: absolute; left: 10%; right: 10%; bottom: var(--gal-bottom); height: var(--gal-dialogue-height); box-sizing: border-box; padding: 25px clamp(30px, 6vw, 120px) 22px; display: flex; flex-direction: column; pointer-events: auto; }
.gal-frame { position: absolute; inset: 0; height: 100%; width: 100%; z-index: -1; filter: drop-shadow(0 5px 0 var(--dialogue-shadow)); }
.gal-frame-paper { fill: var(--dialogue-paper); stroke: var(--dialogue-outline); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.gal-frame-inner { fill: none; stroke: var(--dialogue-inner); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.gal-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 2px solid var(--dialogue-rule); padding-bottom: 7px; margin-bottom: 9px; flex-shrink: 0; }
.gal-heading strong { font-size: clamp(20px, 2.1vw, 29px); font-weight: 800; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.gal-heading-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.gal-page-count { font-size: var(--fs-xs); color: var(--dialogue-muted); white-space: nowrap; }
.gal-choices, .gal-wake { --dialogue-menu-outline: var(--dialogue-control-outline); }
.gal-wake { position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 6px 13px; color: var(--dialogue-menu-text); font-size: var(--fs-xs); font-weight: 800; text-align: center; white-space: nowrap; cursor: pointer; user-select: none; transition: color var(--dur-interaction) var(--ease-standard), transform var(--dur-interaction) var(--ease-standard); }
.gal-wake svg { width: 17px; height: 17px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.gal-wake:hover:not(.is-busy), .gal-wake:focus-visible:not(.is-busy) { transform: translateY(-2px); }
.gal-wake:active:not(.is-busy) { transform: translateY(1px); }
.gal-wake:focus-visible { outline: 2px solid var(--dialogue-menu-text); outline-offset: 3px; }
.gal-wake.is-busy { opacity: .65; cursor: progress; }
.gal-text { flex: 1; min-height: 0; font-size: clamp(18px, 1.65vw, 24px); line-height: 1.65; text-align: left; overflow: hidden; }
.gal-text.can-advance { cursor: pointer; }
.gal-line, .gal-empty { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.gal-unrevealed { visibility: hidden; }
.gal-empty { color: var(--dialogue-muted); }
.gal-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 23px; font-size: var(--fs-xs); color: var(--dialogue-muted); flex-shrink: 0; }
.gal-next { margin-left: auto; color: var(--dialogue-ink); cursor: pointer; font-size: 27px; line-height: 20px; padding: 5px 10px; text-align: center; }
.gal-error { color: var(--danger); }
.gal-choices { position: absolute; right: 10%; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 22px); width: min(370px, 34%); max-height: calc(100% - var(--gal-dialogue-height) - var(--gal-bottom) - 90px); overflow-y: auto; overscroll-behavior: contain; padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 12px; pointer-events: auto; }
.gal-choices > * { flex-shrink: 0; }
.gal-choices > .gal-suggestions { display: flex; flex-direction: column; gap: inherit; flex-shrink: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 0 -12px; padding: 3px 12px 10px; }
.gal-suggestions > * { flex-shrink: 0; }
.gal-choice-status, .gal-missing p { margin: 0; padding: 7px 12px; background: var(--dialogue-paper); color: var(--dialogue-ink); border-radius: var(--radius-sm); font-size: var(--fs-sm); line-height: 1.5; }
.gal-composer { --gal-menu-skew: -5deg; position: relative; isolation: isolate; display: flex; align-items: center; gap: 8px; min-height: var(--gal-choice-height, 46px); padding: 7px 12px 7px 16px; border-radius: 2px; color: var(--dialogue-menu-text); }
.gal-composer:is(:hover, :focus-within):not(.is-disabled) { --gal-menu-outline: var(--dialogue-menu-hover); }
.gal-composer .gal-composer-pen { width: 17px; height: 17px; color: var(--dialogue-menu-text); stroke-width: 2.1; }
.gal-reply-input, .gal-reply-input:hover, .gal-reply-input:focus { flex: 1; min-width: 0; width: 100%; padding: 6px 0; border: 0; border-radius: 0; outline: none; box-shadow: none; background: transparent; color: var(--dialogue-menu-text); font-family: inherit; font-size: 16px; font-weight: 600; line-height: 1.35; }
.gal-send { display: flex; align-items: center; justify-content: center; gap: 3px; flex-shrink: 0; min-width: 56px; min-height: 34px; padding: 4px; color: var(--dialogue-menu-text); font-size: var(--fs-sm); font-weight: 800; text-align: center; cursor: pointer; user-select: none; transition: color var(--dur-interaction) var(--ease-standard), opacity var(--dur-interaction) var(--ease-standard), transform var(--dur-interaction) var(--ease-standard); }
.gal-send svg { width: 18px; height: 18px; }
.gal-send:hover:not(.is-disabled) { transform: translateX(2px); }
.gal-send:active:not(.is-disabled) { transform: translateX(3px); }
.gal-send.is-disabled, .gal-composer.is-disabled { opacity: .5; cursor: not-allowed; }
.gal-reply-input:disabled { cursor: not-allowed; }
.gal-fade-enter-active, .gal-fade-leave-active, .gal-expression-enter-active, .gal-expression-leave-active { transition: opacity .3s var(--ease-standard); }
.gal-fade-enter-from, .gal-fade-leave-to, .gal-expression-enter-from, .gal-expression-leave-to { opacity: 0; }
.is-paused .gal-breath { animation-play-state: paused; }
@keyframes gal-breath { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(1.0075); } }
@media (max-width: 767px) {
  .gal-standing-entry { display: none; }
  .gal-stage { --gal-dialogue-height: clamp(210px, 30dvh, 270px); --gal-bottom: max(12px, env(safe-area-inset-bottom)); }
  .gal-toolbar { top: max(12px, env(safe-area-inset-top)); left: max(12px, env(safe-area-inset-left)); right: max(12px, env(safe-area-inset-right)); gap: 6px; }
  .gal-toolbar-right { gap: 6px; }
  .gal-tool { gap: 5px; padding: 7px 13px; font-size: var(--fs-sm); letter-spacing: .05em; }
  .gal-tool > svg:not(.gal-menu-frame) { width: 18px; height: 18px; }
  .gal-tool::after { left: 36px; right: 13px; }
  .gal-dialogue { left: 3%; right: 3%; padding: 22px 38px 16px; }
  .gal-text { font-size: 18px; }
  .gal-choices { right: 5%; width: min(290px, 76%); gap: 8px; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 14px); }
  .gal-choices > .gal-suggestions { flex-shrink: 0; overflow: visible; }
  .gal-composer { min-height: min(var(--gal-choice-height, 46px), 64px); }
  .gal-photos { left: 3%; width: 42%; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 14px); }
  .gal-photo { padding: 4px; }
  .has-photos .gal-choices { right: 3%; width: 49%; }
}
@media (max-width: 480px) {
  .has-photos .gal-composer { gap: 6px; padding: 7px 10px; }
  .has-photos .gal-composer-pen, .has-photos .gal-send span { display: none; }
  .has-photos .gal-send { min-width: 44px; min-height: 44px; }
}
@media (max-height: 520px) {
  .gal-stage { --gal-dialogue-height: 156px; --gal-bottom: max(8px, env(safe-area-inset-bottom)); }
  .gal-dialogue { left: max(5%, env(safe-area-inset-left)); right: max(5%, env(safe-area-inset-right)); padding: 16px 34px 10px; }
  .gal-heading { margin-bottom: 5px; padding-bottom: 3px; }
  .gal-heading strong { font-size: 19px; }
  .gal-text { font-size: 16px; line-height: 1.5; }
  .gal-choices, .has-photos .gal-choices { width: 40%; right: max(5%, env(safe-area-inset-right)); gap: 5px; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 8px); max-height: calc(100% - var(--gal-dialogue-height) - var(--gal-bottom) - 68px); }
  /* 矮屏整组滚动，避免等高输入框把候选列表压成不可见。 */
  .gal-choices > .gal-suggestions { flex-shrink: 0; overflow: visible; }
  .gal-composer { min-height: 46px; }
  .gal-photos { left: max(5%, env(safe-area-inset-left)); width: 38%; bottom: calc(var(--gal-dialogue-height) + var(--gal-bottom) + 8px); max-height: calc(100% - var(--gal-dialogue-height) - var(--gal-bottom) - 68px); padding: 6px 10px 12px; }
  .gal-photo { --gal-photo-max-height: calc(100dvh - var(--gal-dialogue-height) - var(--gal-bottom) - 94px); align-self: flex-start; max-width: 100%; padding: 4px; }
  .gal-photo :deep(img) { width: auto; max-width: 100%; }
  .gal-toolbar { top: max(8px, env(safe-area-inset-top)); }
}
@media (max-width: 1024px) and (max-height: 520px), (hover: none) and (pointer: coarse) {
  .gal-standing-entry { display: none; }
}
@media (prefers-reduced-motion: reduce) { .gal-breath { animation: none; } }
</style>
