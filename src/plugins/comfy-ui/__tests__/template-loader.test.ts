import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadRaw,
  findSamplerNode,
  findLatentNode,
  findPromptNodes,
  loadTemplate,
  scanWorkflowTemplates,
  scanGuides,
  TemplateLoadError,
  AmbiguousPromptError,
} from '../template-loader'
import {
  minimalWorkflow,
  workflowWithDanglingLora,
  workflowLocked,
  workflowDanglingPoolViaDualClip,
} from './fixtures'

describe('loadRaw', () => {
  it('parses a valid api-format workflow', () => {
    const api = loadRaw(JSON.stringify(minimalWorkflow()), 'w.json')
    expect(api['3'].class_type).toBe('KSampler')
  })
  it('rejects non-object top level', () => {
    expect(() => loadRaw('[1,2,3]', 'bad.json')).toThrow(TemplateLoadError)
  })
  it('rejects a node missing class_type', () => {
    expect(() => loadRaw(JSON.stringify({ '1': { inputs: {} } }), 'bad.json')).toThrow(TemplateLoadError)
  })
  it('rejects invalid json', () => {
    expect(() => loadRaw('{not json', 'bad.json')).toThrow(TemplateLoadError)
  })
  it('rejects a non-object node', () => {
    expect(() => loadRaw(JSON.stringify({ '1': 'nope' }), 'bad.json')).toThrow(TemplateLoadError)
  })
})

describe('findSamplerNode / findLatentNode', () => {
  it('finds the KSampler and EmptyLatentImage', () => {
    const api = minimalWorkflow()
    expect(findSamplerNode(api)).toBe('3')
    expect(findLatentNode(api)).toBe('5')
  })
  it('returns null when sampler absent', () => {
    expect(findSamplerNode({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } })).toBeNull()
  })
  it('picks lowest id when multiple samplers', () => {
    const api: any = { '9': { class_type: 'KSampler', inputs: {} }, '2': { class_type: 'KSamplerAdvanced', inputs: {} } }
    expect(findSamplerNode(api)).toBe('2')
  })
  it('handles EmptySD3LatentImage', () => {
    const api: any = { '1': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024 } } }
    expect(findLatentNode(api)).toBe('1')
  })
  it('returns null when latent absent', () => {
    expect(findLatentNode({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } })).toBeNull()
  })
})

describe('findPromptNodes', () => {
  it('traces positive/negative from KSampler topology', () => {
    const api = minimalWorkflow()
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('falls back to _meta.title keywords when topology indirect', () => {
    // KSampler.positive points at a non-CLIPTextEncode (ConditioningConcat); titles disambiguate.
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['11', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '11': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' }, _meta: { title: 'Positive Prompt' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' }, _meta: { title: 'Negative Prompt' } },
    }
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('infers via negative keywords when exactly two untitled CLIPTextEncode', () => {
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0], negative: ['10', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality, worst quality, bad anatomy' } },
    }
    expect(findPromptNodes(api, '3')).toEqual(['6', '7'])
  })
  it('throws AmbiguousPromptError when unresolvable', () => {
    const api: any = {
      '3': { class_type: 'KSampler', inputs: { positive: ['10', 0] } },
      '10': { class_type: 'ConditioningConcat', inputs: {} },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } },
      '8': { class_type: 'CLIPTextEncode', inputs: { text: 'c' } },
    }
    expect(() => findPromptNodes(api, '3')).toThrow(AmbiguousPromptError)
  })
  it('throws when no sampler', () => {
    expect(() => findPromptNodes(minimalWorkflow(), null)).toThrow(AmbiguousPromptError)
  })
  it('AmbiguousPromptError is a TemplateLoadError', () => {
    expect(() => findPromptNodes(minimalWorkflow(), null)).toThrow(TemplateLoadError)
  })
})

describe('loadTemplate', () => {
  it('assembles bindings from a minimal workflow', () => {
    const t = loadTemplate('w', JSON.stringify(minimalWorkflow()))
    expect(t).toMatchObject({
      name: 'w',
      positiveNode: '6',
      negativeNode: '7',
      samplerNode: '3',
      latentNode: '5',
      seedPrompt: 'masterpiece, 1girl',
      modelSummary: 'anima.safetensors',
    })
    expect(t.seedNegative).toContain('low quality')
    expect(t.defaults.steps).toBe(28)
    expect(t.defaults.width).toBe(832)
    expect(t.modelSource).toEqual(['4', 0])
    expect(t.clipSource).toEqual(['4', 1])
  })

  it('populates the LoRA pool from a dangling loader', () => {
    const t = loadTemplate('w', JSON.stringify(workflowWithDanglingLora()))
    expect(t.availableLoras).toHaveLength(1)
    expect(t.loraLocked).toBe(false)
    expect(t.loraLockReason).toBeNull()
  })

  it('marks a wired LoraLoader template as locked with empty pool', () => {
    const t = loadTemplate('w', JSON.stringify(workflowLocked()))
    expect(t.loraLocked).toBe(true)
    expect(t.availableLoras).toEqual([])
    expect(t.loraLockReason).toContain('pre-wired')
    // model/clip source still traced through the wired LoraLoader
    expect(t.modelSource).toEqual(['1', 0])
    expect(t.clipSource).toEqual(['1', 1])
  })

  it('keeps the pool with distinct dualclip model/clip sources', () => {
    const t = loadTemplate('w', JSON.stringify(workflowDanglingPoolViaDualClip()))
    expect(t.loraLocked).toBe(false)
    expect(t.availableLoras.map((l) => l.name)).toEqual(['loraC.safetensors'])
    expect(t.modelSource).toEqual(['1', 0])
    expect(t.clipSource).toEqual(['10', 0])
  })

  it('throws on a structurally invalid workflow', () => {
    expect(() => loadTemplate('w', '{not json')).toThrow(TemplateLoadError)
  })
})

describe('scanWorkflowTemplates', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfwf-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  it('loads all *.json, tags server, skips broken files', () => {
    writeFileSync(join(dir, 'good.json'), JSON.stringify(minimalWorkflow()))
    writeFileSync(join(dir, 'broken.json'), '{not json')
    const ts = scanWorkflowTemplates(dir, { server: 'box1' })
    expect(ts.map((t) => t.name)).toEqual(['good'])
    expect(ts[0].server).toBe('box1')
  })
  it('ignores non-json files', () => {
    writeFileSync(join(dir, 'junk.txt'), 'not a workflow')
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(minimalWorkflow()))
    const ts = scanWorkflowTemplates(dir)
    expect(ts.map((t) => t.name)).toEqual(['ok'])
  })
  it('returns empty array for a missing directory', () => {
    expect(scanWorkflowTemplates(join(dir, 'does_not_exist'))).toEqual([])
  })
})

describe('scanGuides', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cfgd-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  it('reads *.md as { name, content }', () => {
    writeFileSync(join(dir, 'anima.md'), '# anima tags')
    const gs = scanGuides(dir)
    expect(gs).toEqual([{ name: 'anima', content: '# anima tags' }])
  })
  it('returns empty array for a missing directory', () => {
    expect(scanGuides(join(dir, 'nope'))).toEqual([])
  })
  it('skips unreadable entries and returns the rest', () => {
    // A subdirectory named 'bad.md' causes readFileSync to throw EISDIR.
    mkdirSync(join(dir, 'bad.md'))
    writeFileSync(join(dir, 'good.md'), '# good')
    const gs = scanGuides(dir)
    expect(gs).toEqual([{ name: 'good', content: '# good' }])
  })
})
