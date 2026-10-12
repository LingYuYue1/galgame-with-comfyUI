<template>
  <div ref="entry" class="chat-mode-switch" :class="{ 'is-revealed': hovered || guiding }">
    <div class="mode-switch-action" role="button" tabindex="0" aria-label="切换到 Galgame" @click="switchMode" @keydown.enter.stop.prevent="switchMode" @keydown.space.stop.prevent="switchMode">
      <svg class="mode-switch-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="5" /><path d="m10 9 5 3-5 3Z" />
      </svg>
      <span>Galgame</span>
      <svg class="mode-switch-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
    </div>
    <Transition name="mode-guide">
      <span v-if="guiding" class="mode-switch-guide" role="status">在这里切换对话模式</span>
    </Transition>
  </div>
</template>

<script>
// 设备级的一次性提示；存储不可用时，至少在当前会话中只出现一次。
let guideSeenInSession = false
const GUIDE_KEY = 'linshe:chat-mode-guide-seen:v1'
</script>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({ active: { type: Boolean, default: true } })
const emit = defineEmits(['switch'])
const entry = ref(null)
const hovered = ref(false)
const guiding = ref(false)
let host, guideTimer, dismissTimer, stopWatching

function clearGuide() {
  clearTimeout(guideTimer)
  clearTimeout(dismissTimer)
  guiding.value = false
}
function switchMode() {
  clearGuide()
  rememberGuide()
  hovered.value = false
  emit('switch')
}
function trackPointer(event) {
  if (!props.active || event.pointerType === 'touch') return
  const rect = host.getBoundingClientRect()
  const entryRect = entry.value.getBoundingClientRect()
  // 监听宿主，不铺透明热区，标题栏设置与舞台操作仍可直接点击。
  hovered.value = event.clientX >= rect.right - 220 && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= entryRect.bottom + 24
}
function leaveHost() { hovered.value = false }
function rememberGuide() {
  guideSeenInSession = true
  try { localStorage.setItem(GUIDE_KEY, '1') } catch {}
}
function showFirstGuide() {
  if (guideSeenInSession) return
  try { if (localStorage.getItem(GUIDE_KEY)) return } catch {}
  rememberGuide()
  guiding.value = true
  dismissTimer = setTimeout(() => { guiding.value = false }, 4200)
}
onMounted(() => {
  host = entry.value.closest('.chat-view')
  host?.addEventListener('pointermove', trackPointer, { passive: true })
  host?.addEventListener('pointerleave', leaveHost)
  stopWatching = watch(() => props.active, active => {
    clearGuide()
    hovered.value = false
    if (active) guideTimer = setTimeout(showFirstGuide, 600)
  }, { immediate: true })
})
onBeforeUnmount(() => {
  clearGuide()
  stopWatching?.()
  host?.removeEventListener('pointermove', trackPointer)
  host?.removeEventListener('pointerleave', leaveHost)
})
</script>

<style scoped>
.chat-mode-switch { position: absolute; top: calc(100% + 8px); right: max(16px, env(safe-area-inset-right)); z-index: 6; width: 168px; color: var(--dialogue-ink); opacity: 0; transform: translate(12px, -6px); pointer-events: none; transition: opacity .3s var(--ease-standard), transform .3s var(--ease-standard); }
.chat-mode-switch.is-revealed, .chat-mode-switch:focus-within { opacity: 1; transform: translate(0, 0); }
.mode-switch-action { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 16px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--bg-secondary); box-shadow: var(--shadow-sm); color: var(--accent); font-size: 14px; font-weight: 600; letter-spacing: .02em; text-align: left; cursor: pointer; user-select: none; transition: transform .3s var(--ease-standard); }
.is-revealed .mode-switch-action, .chat-mode-switch:focus-within .mode-switch-action { pointer-events: auto; }
.mode-switch-icon, .mode-switch-arrow { width: 19px; height: 19px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.mode-switch-arrow { width: 15px; height: 15px; margin-left: auto; color: var(--dialogue-muted); transition: transform .3s var(--ease-standard); }
.mode-switch-action:hover .mode-switch-arrow { transform: translateX(3px); }
.mode-switch-action:active { transform: scale(.97); }
.mode-switch-action:focus-visible { outline: 2px solid var(--dialogue-ink); outline-offset: 4px; }
.mode-switch-guide { display: block; margin-top: 10px; padding: 6px 8px; border-radius: var(--radius-sm); background: var(--dialogue-paper); color: var(--dialogue-muted); font-size: 11px; line-height: 1.5; text-align: center; pointer-events: none; }
.mode-guide-enter-active, .mode-guide-leave-active { transition: opacity .3s var(--ease-standard), transform .3s var(--ease-standard); }
.mode-guide-enter-from, .mode-guide-leave-to { opacity: 0; transform: translateY(-4px); }
@media (hover: none), (pointer: coarse) {
  .chat-mode-switch { width: 140px; opacity: 1; transform: none; }
  .mode-switch-action { pointer-events: auto; }
}
</style>
