import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'

const source = parse(readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const nodes = parseJs(source, { sourceType: 'module' }).program.body
function declaration(name) {
  const node = nodes.find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name))
  assert.ok(node, `${name} should exist`)
  return source.slice(node.start, node.end)
}
const { steps, fromValue } = new Function(`
  ${declaration('MOMENT_FREQ_STEPS')}
  ${declaration('DEFAULT_MOMENT_STEP')}
  ${declaration('momentStepFromValue')}
  return { steps: MOMENT_FREQ_STEPS, fromValue: momentStepFromValue }
`)()

test('所有具体时间档与默认档保存后均可正确回显，旧值 1 仍回显默认', () => {
  for (const [index, step] of steps.entries()) {
    const saved = JSON.parse(JSON.stringify({ value: step.value, mode: step.mode || 'interval' }))
    assert.equal(fromValue(saved.value, saved.mode), index, step.label)
  }
  assert.equal(steps[fromValue(1)].label, '默认')
  assert.equal(steps[fromValue(null)].label, '默认')
  assert.equal(steps[fromValue(1, 'interval')].label, '2 小时')
})

test('切换 2 小时和默认时向接口发送不同模式', async () => {
  for (const label of ['2 小时', '默认', '12 小时', '16 小时', '24 小时', '36 小时', '关闭']) {
    const index = steps.findIndex(step => step.label === label)
    const features = {}
    const calls = []
    const onChange = new Function('MOMENT_FREQ_STEPS', 'momentFreqStepIdx', 'features', 'updateMomentFreq', 'toastFn', `
      ${declaration('onMomentFreqChange')}
      return onMomentFreqChange
    `)(steps, { value: index }, features, async (...args) => calls.push(args), () => {})
    await onChange()
    assert.deepEqual(calls, [[steps[index].value, label === '默认' ? 'default' : 'interval']])
    assert.equal(fromValue(features.momentFreq, features.momentFreqMode), index)
  }
})
