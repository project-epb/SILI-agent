// Command-layer LoRA arg validation. Pure function, kept koishi-free so it is
// unit-testable in vitest (importing the plugin index pulls in koishi's loader).
//
// Ported from Hermes' `_validate_loras_arg` in plugins/comfyui/__init__.py.
// Hermes uses snake_case (strength_model); here we use the camelCase shape of
// our OverrideArgs['loras'] (strengthModel / strengthClip).

import type { OverrideArgs, TemplateBindings } from './template-loader'

/**
 * Validate the agent-provided `loras` arg against the template's pool.
 *
 * Returns `{ loras, error }`:
 * - `loras` is null when raw is null / empty (no-op path, same as not passing loras).
 * - `error` is a human-readable message string, or null when valid.
 *
 * Check order mirrors Hermes: locked → unresolvable model/clip → empty pool →
 * per-entry (shape, name, dedup, pool membership, strength types).
 */
export function validateLorasArg(
  raw: unknown,
  t: TemplateBindings
): { loras: OverrideArgs['loras']; error: string | null } {
  if (raw === null || raw === undefined) return { loras: null, error: null }
  if (!Array.isArray(raw)) {
    return { loras: null, error: `loras must be an array, got ${typeof raw}` }
  }
  if (raw.length === 0) return { loras: null, error: null }

  if (t.loraLocked) {
    return {
      loras: null,
      error: `template ${JSON.stringify(t.name)} is author-locked; cannot attach additional LoRA`,
    }
  }
  if (t.modelSource === null || t.clipSource === null) {
    return {
      loras: null,
      error: `template ${JSON.stringify(t.name)} cannot resolve model/clip source; LoRA not supported`,
    }
  }
  if (t.availableLoras.length === 0) {
    return { loras: null, error: `template ${JSON.stringify(t.name)} has no available LoRAs` }
  }

  const poolNames = new Set(t.availableLoras.map((al) => al.name))
  const seen = new Set<string>()
  const parsed: NonNullable<OverrideArgs['loras']> = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { loras: null, error: `loras[${i}] must be an object, got ${typeof entry}` }
    }
    const e = entry as Record<string, unknown>
    const name = e.name
    if (typeof name !== 'string' || !name) {
      return { loras: null, error: `loras[${i}].name must be a non-empty string` }
    }
    if (seen.has(name)) {
      return { loras: null, error: `lora ${JSON.stringify(name)} specified more than once` }
    }
    seen.add(name)
    if (!poolNames.has(name)) {
      const available = [...poolNames].sort()
      return {
        loras: null,
        error: `unknown lora ${JSON.stringify(name)}; available: ${JSON.stringify(available)}`,
      }
    }
    const sm = e.strengthModel
    const sc = e.strengthClip
    if (sm !== undefined && sm !== null && typeof sm !== 'number') {
      return {
        loras: null,
        error: `lora ${JSON.stringify(name)} strengthModel must be a number, got ${JSON.stringify(sm)}`,
      }
    }
    if (sc !== undefined && sc !== null && typeof sc !== 'number') {
      return {
        loras: null,
        error: `lora ${JSON.stringify(name)} strengthClip must be a number, got ${JSON.stringify(sc)}`,
      }
    }
    const clean: NonNullable<OverrideArgs['loras']>[number] = { name }
    if (typeof sm === 'number') clean.strengthModel = sm
    if (typeof sc === 'number') clean.strengthClip = sc
    parsed.push(clean)
  }
  return { loras: parsed, error: null }
}
