import { describe, it, expect } from 'vitest'
import {
  extractDefaults,
  extractModelSummary,
  scanLoraPool,
  traceModelSource,
  traceClipSource,
} from '../template-loader'
import {
  minimalWorkflow,
  workflowWithDanglingLora,
  workflowNoLora,
  workflowDanglingPool,
  workflowLocked,
  workflowMixedLockedAndDangling,
  workflowDanglingPoolViaDualClip,
} from './fixtures'

describe('extractDefaults', () => {
  it('pulls widget scalars from sampler + latent', () => {
    const d = extractDefaults(minimalWorkflow(), '3', '5')
    expect(d).toMatchObject({
      steps: 28,
      cfg: 5,
      sampler_name: 'euler',
      scheduler: 'normal',
      width: 832,
      height: 1216,
    })
  })
  it('returns empty object when no sampler', () => {
    expect(extractDefaults({}, null, null)).toEqual({})
  })
  it('skips linked (non-widget) inputs', () => {
    const api: any = { '3': { class_type: 'KSampler', inputs: { steps: ['9', 0], cfg: 5 } } }
    const d = extractDefaults(api, '3', null)
    expect(d.cfg).toBe(5)
    expect('steps' in d).toBe(false)
  })
})

describe('extractModelSummary', () => {
  it('joins loader filenames', () => {
    expect(extractModelSummary(minimalWorkflow())).toBe('anima.safetensors')
  })
  it('handles a checkpoint loader', () => {
    const api: any = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    }
    expect(extractModelSummary(api)).toContain('sd_xl_base_1.0.safetensors')
  })
  it('returns placeholder when no loaders', () => {
    expect(extractModelSummary({})).toBe('(no loader nodes)')
  })
  it('joins UNETLoader + DualCLIPLoader filenames', () => {
    const s = extractModelSummary(workflowDanglingPoolViaDualClip())
    expect(s).toContain('model.gguf')
    expect(s).toContain('clip_l.safetensors')
  })
})

describe('scanLoraPool', () => {
  it('returns empty pool when no LoraLoader', () => {
    expect(scanLoraPool(minimalWorkflow())).toEqual({ pool: [], locked: false, lockedIds: [] })
    expect(scanLoraPool(workflowNoLora())).toEqual({ pool: [], locked: false, lockedIds: [] })
  })
  it('collects a dangling LoraLoader into the pool', () => {
    const r = scanLoraPool(workflowWithDanglingLora())
    expect(r.locked).toBe(false)
    expect(r.pool).toHaveLength(1)
    expect(r.pool[0]).toMatchObject({
      name: 'detail.safetensors',
      nodeId: '20',
      strengthModel: 0.8,
      strengthClip: 0.8,
    })
  })
  it('collects two dangling LoraLoaders', () => {
    const r = scanLoraPool(workflowDanglingPool())
    expect(r.locked).toBe(false)
    expect(r.lockedIds).toEqual([])
    const names = r.pool.map((p) => p.name).sort()
    expect(names).toEqual(['loraA.safetensors', 'loraB.safetensors'])
    const byName = Object.fromEntries(r.pool.map((p) => [p.name, p]))
    expect(byName['loraA.safetensors'].nodeId).toBe('100')
    expect(byName['loraA.safetensors'].strengthModel).toBe(0.8)
    expect(byName['loraA.safetensors'].strengthClip).toBe(0.8)
    expect(byName['loraB.safetensors'].strengthModel).toBe(0.5)
  })
  it('marks template locked when a LoraLoader is wired into the main path', () => {
    const r = scanLoraPool(workflowLocked())
    expect(r.locked).toBe(true)
    expect(r.lockedIds).toEqual(['100'])
    expect(r.pool).toEqual([])
  })
  it('locked when a LoraLoader is wired via KSampler.model directly', () => {
    const api: any = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '20': {
        class_type: 'LoraLoader',
        inputs: { lora_name: 'x.safetensors', strength_model: 1, strength_clip: 1, model: ['4', 0], clip: ['4', 1] },
      },
      '3': { class_type: 'KSampler', inputs: { model: ['20', 0] } },
    }
    const r = scanLoraPool(api)
    expect(r.locked).toBe(true)
    expect(r.lockedIds).toContain('20')
    expect(r.pool).toEqual([])
  })
  it('mixed locked + dangling is still locked with empty pool', () => {
    const r = scanLoraPool(workflowMixedLockedAndDangling())
    expect(r.locked).toBe(true)
    expect(r.lockedIds).toEqual(['100'])
    expect(r.pool).toEqual([])
  })
  it('skips a node with a missing strength widget', () => {
    const api = workflowDanglingPool()
    delete api['100'].inputs.strength_model
    const r = scanLoraPool(api)
    expect(r.locked).toBe(false)
    expect(r.pool.map((p) => p.name)).toEqual(['loraB.safetensors'])
  })
  it('a self-reference does not lock', () => {
    const api = workflowDanglingPool()
    api['100'].inputs.self_link = ['100', 0]
    const r = scanLoraPool(api)
    expect(r.locked).toBe(false)
    expect(r.pool.map((p) => p.name).sort()).toEqual(['loraA.safetensors', 'loraB.safetensors'])
  })
  it('skips a node with non-numeric (linked) strength widget', () => {
    const api: any = {
      '20': { class_type: 'LoraLoader', inputs: { lora_name: 'x', strength_model: ['9', 0], strength_clip: 1 } },
    }
    expect(scanLoraPool(api).pool).toEqual([])
  })
  it('skips a node with boolean strength widget', () => {
    const api = workflowDanglingPool()
    api['100'].inputs.strength_model = true
    const r = scanLoraPool(api)
    expect(r.locked).toBe(false)
    expect(r.pool.map((p) => p.name)).toEqual(['loraB.safetensors'])
  })
})

describe('trace source', () => {
  it('traces model source through to checkpoint', () => {
    expect(traceModelSource(minimalWorkflow(), '3')).toEqual(['4', 0])
  })
  it('traces clip source from positive node', () => {
    expect(traceClipSource(minimalWorkflow(), '6')).toEqual(['4', 1])
  })
  it('traces model/clip on the dangling-pool fixture', () => {
    const api = workflowDanglingPool()
    expect(traceModelSource(api, '5')).toEqual(['1', 0])
    expect(traceClipSource(api, '2')).toEqual(['1', 1])
  })
  it('traces clip through a separate DualCLIPLoader', () => {
    const api = workflowDanglingPoolViaDualClip()
    expect(traceClipSource(api, '2')).toEqual(['10', 0])
  })
  it('traces model through UNETLoader', () => {
    const api = workflowDanglingPoolViaDualClip()
    expect(traceModelSource(api, '5')).toEqual(['1', 0])
  })
  it('traces through a wired LoraLoader (locked template)', () => {
    const api = workflowLocked()
    expect(traceModelSource(api, '5')).toEqual(['1', 0])
    expect(traceClipSource(api, '2')).toEqual(['1', 1])
  })
  it('returns null when link missing', () => {
    expect(traceModelSource({ '3': { class_type: 'KSampler', inputs: {} } } as any, '3')).toBeNull()
  })
  it('returns null when link malformed', () => {
    const api = workflowDanglingPool()
    api['5'].inputs.model = 'not-a-link'
    expect(traceModelSource(api, '5')).toBeNull()
  })
})
