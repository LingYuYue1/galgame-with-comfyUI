<template>
  <div class="chat-bg-panel">
    <div class="cbp-title">背景图</div>
    <linshe-tabs v-model="target" size="sm" :options="[{ label: '聊天背景', value: 'chat' }, { label: 'Galgame 背景', value: 'galgame' }]" :disabled="locked" aria-label="背景类型" />
    <Transition name="cbp-fade" mode="out-in">
      <div :key="target" class="cbp-content">
        <div class="cbp-preview" :class="{ 'is-default': !previewBg }" :style="previewBg ? { backgroundImage: `url(${previewBg})` } : {}">
          <span class="cbp-default-hint">{{ currentBg ? '自定义背景' : target === 'galgame' && previewBg ? '沿用聊天背景' : '默认 · 主题背景' }}</span>
        </div>
        <p v-if="target === 'galgame'" class="cbp-note">仅用于沉浸对话，未设置时沿用聊天背景。</p>
        <div class="cbp-actions">
          <linshe-button class="cbp-act" variant="secondary" size="sm" :disabled="locked" @click="pickFile">本地上传</linshe-button>
          <linshe-button v-if="previewBg" class="cbp-act" variant="secondary" size="sm" :disabled="locked" @click="editCrop">调整取景</linshe-button>
          <linshe-button v-if="currentBg" class="cbp-act" variant="ghost" size="sm" :disabled="locked" @click="resetBg">恢复默认</linshe-button>
        </div>
        <template v-if="target === 'galgame'">
          <linshe-input v-model="requirement" type="textarea" :rows="2" :maxlength="500" aria-label="Galgame 背景画面要求" placeholder="描述想要的场景；留空按角色设定设计" :disabled="locked" />
          <linshe-button variant="primary" size="sm" :disabled="locked" :loading="generating" @click="generateBg">生成 Galgame 背景</linshe-button>
        </template>
      </div>
    </Transition>
    <input ref="fileEl" type="file" accept="image/*" hidden @change="onFile" />
    <div v-if="busyText" class="cbp-note" role="status">{{ busyText }}</div>
    <BackgroundCropper v-model="cropOpen" :src="cropSrc" :title="cropContext?.target === 'galgame' ? 'Galgame 背景取景' : '聊天背景取景'" :aspect-ratio="cropContext?.aspect || 16 / 9" :saving="busy" @save="saveCrop" />
  </div>
</template>

<script setup>
import { ref, computed, inject, watch, onBeforeUnmount } from 'vue'
import * as api from '../api/index.js'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import LinsheInput from './ui/LinsheInput.vue'
import BackgroundCropper from './BackgroundCropper.vue'

const props = defineProps({
  character: { type: Object, default: null },
})
const emit = defineEmits(['updated'])

const toast = inject('toast', () => {})

const target = ref('chat')
const requirement = ref('')
const generating = ref(false)
const currentBg = computed(() => props.character?.[target.value === 'galgame' ? 'galgame_bg_path' : 'chat_bg_path'] || '')
const previewBg = computed(() => currentBg.value || (target.value === 'galgame' ? props.character?.chat_bg_path : '') || '')
const busy = ref(false)
const busyText = ref('')
const fileEl = ref(null)
const cropOpen = ref(false), cropSrc = ref(''), cropContext = ref(null)
const locked = computed(() => busy.value || cropOpen.value)
let uploadContext = null
let objectUrl = '', releaseTimer, disposed = false

function releaseCrop() {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''; cropSrc.value = ''; cropContext.value = null
}
watch(cropOpen, open => {
  clearTimeout(releaseTimer)
  if (!open) releaseTimer = setTimeout(releaseCrop, 300)
})
onBeforeUnmount(() => { disposed = true; clearTimeout(releaseTimer); releaseCrop() })
function selectionContext() {
  const rect = document.querySelector('.chat-view')?.getBoundingClientRect()
  return { characterId: props.character.id, target: target.value, aspect: rect?.width && rect?.height ? rect.width / rect.height : 16 / 9 }
}
function openCrop(src, context) {
  clearTimeout(releaseTimer)
  cropContext.value = context; cropSrc.value = src; cropOpen.value = true
}
function editCrop() { if (!locked.value && props.character && previewBg.value) openCrop(previewBg.value, selectionContext()) }

watch(() => props.character?.id, () => { requirement.value = ''; uploadContext = null; cropOpen.value = false })
function pickFile() {
  if (locked.value || !props.character) return
  uploadContext = selectionContext()
  fileEl.value?.click()
}

function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  const context = uploadContext
  uploadContext = null
  if (!file || !context || locked.value || context.characterId !== props.character?.id) return
  if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'error'); return }
  releaseCrop()
  objectUrl = URL.createObjectURL(file)
  openCrop(objectUrl, context)
}

async function saveCrop(base64) {
  const context = cropContext.value
  if (busy.value || !context) return
  try {
    busy.value = true; busyText.value = '保存中…'
    const result = await api.uploadChatBg(context.characterId, base64, context.target)
    if (!result.ok) throw new Error(result.error || '保存失败')
    emit('updated', result)
    cropOpen.value = false
    toast(context.target === 'galgame' ? 'Galgame 背景已更新' : '聊天背景已更新')
  } catch (err) {
    toast(err.message || '上传失败', 'error')
  } finally {
    busy.value = false; busyText.value = ''
  }
}

async function saveBg(base64) {
  if (locked.value || !props.character) return
  const characterId = props.character.id, selectedTarget = target.value
  try {
    busy.value = true; busyText.value = '保存中…'
    const r = await api.uploadChatBg(characterId, base64, selectedTarget)
    if (r.ok) {
      emit('updated', r)
      toast(base64 ? '背景已更新' : '已恢复默认背景')
    } else {
      toast(r.error || '保存失败', 'error')
    }
  } catch (err) {
    toast(err.message || '保存失败', 'error')
  } finally {
    busy.value = false; busyText.value = ''
  }
}

function resetBg() { saveBg('') }

async function generateBg() {
  if (locked.value || !props.character) return
  const context = selectionContext()
  try {
    busy.value = true; generating.value = true; busyText.value = '正在设计并生成 Galgame 背景…'
    const result = await api.generateChatBg(context.characterId, requirement.value, 'galgame', true)
    if (!result.ok || !result.imageUrl) throw new Error(result.error || '生成失败')
    if (!disposed && props.character?.id === context.characterId) openCrop(result.imageUrl, context)
    toast('背景已生成，确认取景后应用')
  } catch (err) {
    toast(err.message || '生成失败', 'error')
  } finally {
    busy.value = false; generating.value = false; busyText.value = ''
  }
}
</script>

<style scoped>
.chat-bg-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
}
.cbp-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 1px;
}
.cbp-content { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.cbp-fade-enter-active, .cbp-fade-leave-active { transition: opacity var(--dur-interaction) var(--ease-standard); }
.cbp-fade-enter-from, .cbp-fade-leave-to { opacity: 0; }
.cbp-preview {
  height: 92px;
  border-radius: 10px;
  background-size: cover;
  background-position: center;
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.cbp-preview.is-default {
  background: var(--bg-tertiary);
}
.cbp-default-hint, .cbp-custom-hint {
  font-size: 11.5px;
  color: var(--text-bright);
  background: var(--popover-bg);
  border: 1px solid var(--glass-border);
  padding: 3px 10px;
  border-radius: 20px;
  backdrop-filter: blur(6px);
}
.cbp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cbp-act {
  flex: 1;
  min-width: 0;
}
.cbp-note {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
