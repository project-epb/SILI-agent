import { describe, it, expect } from 'vitest'

import { validateLorasArg } from '../lora-validate'
import { loadTemplate } from '../template-loader'

import { workflowWithDanglingLora, minimalWorkflow } from './fixtures'

const poolT = loadTemplate('p', JSON.stringify(workflowWithDanglingLora()))

describe('validateLorasArg', () => {
  it('null/empty → no loras, no error', () => {
    expect(validateLorasArg(null, poolT)).toEqual({ loras: null, error: null })
    expect(validateLorasArg([], poolT)).toEqual({ loras: null, error: null })
  })

  it('rejects unknown lora name', () => {
    expect(validateLorasArg([{ name: 'nope.safetensors' }], poolT).error).toMatch(/unknown/i)
  })

  it('rejects duplicate names', () => {
    const r = validateLorasArg(
      [{ name: 'detail.safetensors' }, { name: 'detail.safetensors' }],
      poolT
    )
    expect(r.error).toMatch(/more than once|duplicate/i)
  })

  it('rejects non-number strength', () => {
    expect(
      validateLorasArg([{ name: 'detail.safetensors', strengthModel: 'x' as any }], poolT).error
    ).toMatch(/number/i)
  })

  it('rejects loras against a template without pool', () => {
    const noPool = loadTemplate('np', JSON.stringify(minimalWorkflow()))
    expect(validateLorasArg([{ name: 'detail.safetensors' }], noPool).error).toBeTruthy()
  })

  it('accepts a valid lora from the pool', () => {
    const r = validateLorasArg([{ name: 'detail.safetensors', strengthModel: 0.6 }], poolT)
    expect(r.error).toBeNull()
    expect(r.loras).toEqual([{ name: 'detail.safetensors', strengthModel: 0.6 }])
  })

  it('rejects non-array raw', () => {
    expect(validateLorasArg({ name: 'detail.safetensors' } as any, poolT).error).toMatch(/array/i)
  })

  it('rejects an entry that is not an object', () => {
    expect(validateLorasArg(['detail.safetensors'] as any, poolT).error).toMatch(/object/i)
  })

  it('rejects an entry with a non-string name', () => {
    expect(validateLorasArg([{ name: 123 } as any], poolT).error).toMatch(/name/i)
  })
})
