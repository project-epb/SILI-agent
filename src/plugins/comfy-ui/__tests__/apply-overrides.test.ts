import { describe, it, expect } from 'vitest'
import {
  applyOverrides,
  findSamplerNode,
  findLatentNode,
  findPromptNodes,
  extractDefaults,
  extractModelSummary,
  scanLoraPool,
  traceModelSource,
  traceClipSource,
  type TemplateBindings,
} from '../template-loader'
import {
  minimalWorkflow,
  workflowNoLora,
  workflowDanglingPool,
  workflowDanglingPoolViaDualClip,
} from './fixtures'

// Local helper: assemble TemplateBindings from a raw workflow object using the
// Task 2/3 primitives. Avoids a forward dependency on Task 5's loadTemplate.
function buildBindings(name: string, api: Record<string, any>): TemplateBindings {
  const samplerId = findSamplerNode(api)
  const latentId = findLatentNode(api)
  const [posId, negId] = findPromptNodes(api, samplerId)
  const text = (id: string | null) => (id ? String(api[id]?.inputs?.text ?? '') : '')
  const { pool } = scanLoraPool(api)
  return {
    name,
    positiveNode: posId,
    negativeNode: negId,
    samplerNode: samplerId,
    latentNode: latentId,
    seedPrompt: text(posId),
    seedNegative: text(negId),
    defaults: extractDefaults(api, samplerId, latentId),
    modelSummary: extractModelSummary(api),
    raw: api,
    availableLoras: pool,
    modelSource: samplerId ? traceModelSource(api, samplerId) : null,
    clipSource: traceClipSource(api, posId),
    loraLocked: false,
    loraLockReason: null,
  }
}

describe('applyOverrides — basics', () => {
  it('does not mutate the template raw', () => {
    const t = buildBindings('m', minimalWorkflow())
    const originalText = t.raw[t.positiveNode].inputs.text
    applyOverrides(t, { prompt: 'MUTATED', negative: 'MUTATED', aspectRatio: 'portrait', steps: 99, cfg: 9.9, seed: 99 })
    expect(t.raw[t.positiveNode].inputs.text).toBe(originalText)
    expect(t.raw[t.positiveNode].inputs.text).not.toBe('MUTATED')
    expect(t.raw[t.samplerNode!].inputs.steps).toBe(28)
    expect(t.raw[t.latentNode!].inputs.width).toBe(832)
  })

  it('replaces positive prompt (never appends)', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'a cat', seed: 42 })
    expect(out[t.positiveNode].inputs.text).toBe('a cat')
    // negative untouched
    expect(out[t.negativeNode!].inputs.text).toContain('low quality')
  })

  it('overrides negative only when explicitly given', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', negative: 'ugly, deformed', seed: 1 })
    expect(out[t.negativeNode!].inputs.text).toBe('ugly, deformed')
  })

  it('aspect_ratio sets latent width/height (portrait)', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', aspectRatio: 'portrait', seed: 1 })
    expect(out[t.latentNode!].inputs.width).toBe(832)
    expect(out[t.latentNode!].inputs.height).toBe(1216)
  })

  it('aspect_ratio landscape', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', aspectRatio: 'landscape', seed: 1 })
    expect(out[t.latentNode!].inputs.width).toBe(1216)
    expect(out[t.latentNode!].inputs.height).toBe(832)
  })

  it('unknown aspect_ratio falls back to template defaults', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', aspectRatio: 'weird', seed: 1 })
    expect(out[t.latentNode!].inputs.width).toBe(832)
  })

  it('explicit width/height takes precedence over aspect_ratio', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', aspectRatio: 'portrait', width: 1344, height: 768, seed: 1 })
    expect(out[t.latentNode!].inputs.width).toBe(1344)
    expect(out[t.latentNode!].inputs.height).toBe(768)
  })

  it('injects seed/steps/cfg into sampler', () => {
    const t = buildBindings('m', minimalWorkflow())
    const out = applyOverrides(t, { prompt: 'x', steps: 8, cfg: 4.5, seed: 12345 })
    const s = out[t.samplerNode!].inputs
    expect(s.seed).toBe(12345)
    expect(s.steps).toBe(8)
    expect(s.cfg).toBe(4.5)
  })

  it('skips a linked sampler field (warn-and-skip, value unchanged)', () => {
    const api: any = {
      '1': { class_type: 'PrimitiveInt', inputs: { value: 20 } },
      '9': {
        class_type: 'KSampler',
        inputs: {
          seed: 0, steps: ['1', 0], cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0,
          positive: ['2', 0], negative: ['3', 0],
        },
      },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'good' }, _meta: { title: 'Positive' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality' }, _meta: { title: 'Negative' } },
    }
    const t = buildBindings('t', api)
    const out = applyOverrides(t, { prompt: 'x', steps: 8, seed: 1 })
    expect(out['9'].inputs.steps).toEqual(['1', 0])
  })
})

describe('applyOverrides — LoRA chain wiring', () => {
  it('no loras → main-path byte-equivalent to bare baseline', () => {
    const tPool = buildBindings('pool', workflowDanglingPool())
    const outPool = applyOverrides(tPool, { prompt: 'hello', seed: 42 })
    const tBare = buildBindings('bare', workflowNoLora())
    const outBare = applyOverrides(tBare, { prompt: 'hello', seed: 42 })
    for (const nid of ['1', '2', '3', '4', '5', '6', '7']) {
      expect(outPool[nid]).toEqual(outBare[nid])
    }
    // dangling lora nodes still present, untouched
    expect(outPool['100'].inputs.lora_name).toBe('loraA.safetensors')
    expect('model' in outPool['100'].inputs).toBe(false)
  })

  it('single lora wires into main path and redirects references', () => {
    const t = buildBindings('t', workflowDanglingPool())
    const out = applyOverrides(t, { prompt: 'hello', seed: 42, loras: [{ name: 'loraA.safetensors' }] })
    expect(out['100'].inputs.model).toEqual(['1', 0])
    expect(out['100'].inputs.clip).toEqual(['1', 1])
    // authored strengths preserved
    expect(out['100'].inputs.strength_model).toBe(0.8)
    expect(out['100'].inputs.strength_clip).toBe(0.8)
    // downstream redirects
    expect(out['5'].inputs.model).toEqual(['100', 0])
    expect(out['2'].inputs.clip).toEqual(['100', 1])
    expect(out['3'].inputs.clip).toEqual(['100', 1])
    // VAE link to "1" slot 2 stays
    expect(out['6'].inputs.vae).toEqual(['1', 2])
    // other dangling node untouched
    expect('model' in out['101'].inputs).toBe(false)
  })

  it('two-lora chain links in order', () => {
    const t = buildBindings('t', workflowDanglingPool())
    const out = applyOverrides(t, {
      prompt: 'hello',
      seed: 42,
      loras: [{ name: 'loraA.safetensors' }, { name: 'loraB.safetensors' }],
    })
    expect(out['100'].inputs.model).toEqual(['1', 0])
    expect(out['100'].inputs.clip).toEqual(['1', 1])
    expect(out['101'].inputs.model).toEqual(['100', 0])
    expect(out['101'].inputs.clip).toEqual(['100', 1])
    expect(out['5'].inputs.model).toEqual(['101', 0])
    expect(out['2'].inputs.clip).toEqual(['101', 1])
    expect(out['3'].inputs.clip).toEqual(['101', 1])
  })

  it('strength overrides applied; preserved when absent', () => {
    const t = buildBindings('t', workflowDanglingPool())
    const out = applyOverrides(t, {
      prompt: 'hello',
      seed: 42,
      loras: [
        { name: 'loraA.safetensors', strengthModel: 0.3 },
        { name: 'loraB.safetensors', strengthClip: 0.1 },
      ],
    })
    expect(out['100'].inputs.strength_model).toBe(0.3)
    expect(out['100'].inputs.strength_clip).toBe(0.8)
    expect(out['101'].inputs.strength_model).toBe(0.5)
    expect(out['101'].inputs.strength_clip).toBe(0.1)
  })

  it('respects strength 0 (is-not-undefined gate, not truthiness)', () => {
    const t = buildBindings('t', workflowDanglingPool())
    const out = applyOverrides(t, {
      prompt: 'hello',
      seed: 42,
      loras: [{ name: 'loraA.safetensors', strengthModel: 0.0, strengthClip: 0.0 }],
    })
    expect(out['100'].inputs.strength_model).toBe(0.0)
    expect(out['100'].inputs.strength_clip).toBe(0.0)
  })

  it('reordered lora array determines chain order', () => {
    const t = buildBindings('t', workflowDanglingPool())
    const out = applyOverrides(t, {
      prompt: 'hello',
      seed: 42,
      loras: [{ name: 'loraB.safetensors' }, { name: 'loraA.safetensors' }],
    })
    // L0 = "101" (loraB), L1 = "100" (loraA)
    expect(out['101'].inputs.model).toEqual(['1', 0])
    expect(out['100'].inputs.model).toEqual(['101', 0])
    expect(out['5'].inputs.model).toEqual(['100', 0])
    expect(out['2'].inputs.clip).toEqual(['100', 1])
  })

  it('handles distinct model/clip sources (dualclip)', () => {
    const t = buildBindings('t', workflowDanglingPoolViaDualClip())
    expect(t.modelSource).toEqual(['1', 0])
    expect(t.clipSource).toEqual(['10', 0])
    const out = applyOverrides(t, { prompt: 'hello', seed: 42, loras: [{ name: 'loraC.safetensors' }] })
    expect(out['100'].inputs.model).toEqual(['1', 0])
    expect(out['100'].inputs.clip).toEqual(['10', 0])
    expect(out['5'].inputs.model).toEqual(['100', 0])
    expect(out['2'].inputs.clip).toEqual(['100', 1])
    expect(out['3'].inputs.clip).toEqual(['100', 1])
  })
})
