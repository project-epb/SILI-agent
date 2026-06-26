/**
 * Load + parse ComfyUI API-format workflow templates.
 *
 * Templates are pre-exported from ComfyUI Web UI via Workflow -> Export (API).
 * This module reads them, runs heuristic field extraction, and produces an
 * overrides-applicable representation (TemplateBindings).
 *
 * Ported from Hermes' template_loader.py — kept logically equivalent.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, parse as parsePath } from 'node:path'

export interface AvailableLora {
  name: string
  nodeId: string
  strengthModel: number
  strengthClip: number
}

export interface TemplateBindings {
  name: string
  server?: string // reserved; always undefined in this version (no multi-backend)
  positiveNode: string
  negativeNode: string | null
  samplerNode: string | null
  latentNode: string | null
  seedPrompt: string
  seedNegative: string
  defaults: Record<string, any> // steps/cfg/sampler_name/scheduler/width/height...
  modelSummary: string
  raw: Record<string, any>
  availableLoras: AvailableLora[]
  modelSource: [string, number] | null
  clipSource: [string, number] | null
  loraLocked: boolean
  loraLockReason: string | null
}

export interface Guide {
  name: string
  content: string
}

export class TemplateLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateLoadError'
  }
}

export class AmbiguousPromptError extends TemplateLoadError {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousPromptError'
  }
}

/**
 * Parse a ComfyUI API-format JSON string and return its object.
 * Raises TemplateLoadError on parse failure or structural problems.
 */
export function loadRaw(text: string, name: string): Record<string, any> {
  let data: any
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new TemplateLoadError(`failed to parse ${name}: ${e}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    const got = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data
    throw new TemplateLoadError(
      `${name}: top-level value must be a JSON object (dict by node id), got ${got}`
    )
  }
  for (const [nid, node] of Object.entries(data)) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new TemplateLoadError(`${name}: node ${JSON.stringify(nid)} is not an object`)
    }
    if (!('class_type' in (node as object))) {
      throw new TemplateLoadError(`${name}: node ${JSON.stringify(nid)} missing 'class_type'`)
    }
  }
  return data
}

/** Sort node ids numerically when possible, alphabetically otherwise. */
function sortedNodeIds(api: Record<string, any>): string[] {
  return Object.keys(api).sort((a, b) => {
    const na = Number.isInteger(Number(a)) && a.trim() !== '' ? Number(a) : NaN
    const nb = Number.isInteger(Number(b)) && b.trim() !== '' ? Number(b) : NaN
    const aNum = !Number.isNaN(na)
    const bNum = !Number.isNaN(nb)
    // numeric ids (group 0) sort before string ids (group 1)
    if (aNum && bNum) return na - nb
    if (aNum) return -1
    if (bNum) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Return the node id of the first KSampler-family node (lowest id wins).
 * Recognises class_types starting with 'KSampler' (KSampler, KSamplerAdvanced).
 */
export function findSamplerNode(api: Record<string, any>): string | null {
  for (const nid of sortedNodeIds(api)) {
    const ct = api[nid]?.class_type ?? ''
    if (typeof ct === 'string' && ct.startsWith('KSampler')) return nid
  }
  return null
}

/**
 * Return the node id of the first Empty*LatentImage node (lowest id wins).
 * Recognises EmptyLatentImage and EmptySD3LatentImage.
 */
export function findLatentNode(api: Record<string, any>): string | null {
  const targets = new Set(['EmptyLatentImage', 'EmptySD3LatentImage'])
  for (const nid of sortedNodeIds(api)) {
    if (targets.has(api[nid]?.class_type)) return nid
  }
  return null
}

// Title-keyword sniffers for fallback rule 2
const POS_KEYWORDS = ['positive', 'pos ', '正面', '正向']
const NEG_KEYWORDS = ['negative', 'neg', '负面', '负向', '反向']
const NEG_TEXT_HINTS = [
  'low quality',
  'worst quality',
  'bad anatomy',
  'watermark',
  'deformed',
  'blurry',
  'jpeg artifacts',
]

function isClipTextEncode(node: any): boolean {
  return node?.class_type === 'CLIPTextEncode'
}

function nodeTitle(node: any): string {
  const meta = node?._meta ?? {}
  return String(meta?.title ?? '').toLowerCase()
}

function nodeText(node: any): string {
  return String(node?.inputs?.text ?? '')
}

function isLink(v: any): v is [string | number, number] {
  return Array.isArray(v) && v.length === 2
}

/** Rule 1: KSampler.positive / KSampler.negative directly point at CLIPTextEncode. */
function tryTopologyTrace(api: Record<string, any>, samplerId: string): [string | null, string | null] {
  const inputs = api[samplerId]?.inputs ?? {}
  const resolve = (link: any): string | null => {
    if (isLink(link)) {
      const targetId = String(link[0])
      const target = api[targetId]
      if (target && isClipTextEncode(target)) return targetId
    }
    return null
  }
  return [resolve(inputs.positive), resolve(inputs.negative)]
}

/** Rule 2: scan all CLIPTextEncode nodes' _meta.title for keywords. */
function tryTitleMatch(api: Record<string, any>): [string | null, string | null] {
  let posId: string | null = null
  let negId: string | null = null
  for (const nid of sortedNodeIds(api)) {
    const node = api[nid]
    if (!isClipTextEncode(node)) continue
    const title = nodeTitle(node)
    if (!title) continue
    if (NEG_KEYWORDS.some((k) => title.includes(k))) {
      if (negId === null) negId = nid
    } else if (POS_KEYWORDS.some((k) => title.includes(k))) {
      if (posId === null) posId = nid
    }
  }
  return [posId, negId]
}

/** Rule 3: exactly two CLIPTextEncode nodes; one has obvious negative keywords. */
function tryNegativeKeywordInference(api: Record<string, any>): [string | null, string | null] {
  const textNodes = sortedNodeIds(api)
    .filter((nid) => isClipTextEncode(api[nid]))
    .map((nid) => [nid, api[nid]] as const)
  if (textNodes.length !== 2) return [null, null]
  const [aId, aNode] = textNodes[0]
  const [bId, bNode] = textNodes[1]
  const aText = nodeText(aNode).toLowerCase()
  const bText = nodeText(bNode).toLowerCase()
  const aIsNeg = NEG_TEXT_HINTS.some((h) => aText.includes(h))
  const bIsNeg = NEG_TEXT_HINTS.some((h) => bText.includes(h))
  if (aIsNeg && !bIsNeg) return [bId, aId]
  if (bIsNeg && !aIsNeg) return [aId, bId]
  return [null, null]
}

/**
 * Identify positive (and optionally negative) CLIPTextEncode node ids.
 * Applies four rules in order: topology trace, title keywords, negative-keyword
 * inference, otherwise raise AmbiguousPromptError. Returns [positiveId, negativeId|null].
 */
export function findPromptNodes(
  api: Record<string, any>,
  samplerId: string | null
): [string, string | null] {
  if (samplerId === null || !(samplerId in api)) {
    throw new AmbiguousPromptError(
      'no KSampler in template; cannot identify positive/negative prompts'
    )
  }

  // Rule 1
  const [pos, neg] = tryTopologyTrace(api, samplerId)
  if (pos !== null) return [pos, neg]

  // Rule 2
  const [pos2, neg2] = tryTitleMatch(api)
  if (pos2 !== null) return [pos2, neg2 !== null ? neg2 : neg]

  // Rule 3
  const [pos3, neg3] = tryNegativeKeywordInference(api)
  if (pos3 !== null) return [pos3, neg3]

  throw new AmbiguousPromptError(
    'cannot identify positive CLIPTextEncode: topology trace failed, ' +
      'no node title contains positive/negative keywords, and node count != 2 ' +
      'for keyword inference. Set _meta.title on the prompt nodes.'
  )
}

// Sampler-widget keys we surface as defaults (only widget-style scalars)
const SAMPLER_WIDGET_KEYS = ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']
const LATENT_WIDGET_KEYS = ['width', 'height']
const LOADER_KEY_BY_CLASS: Record<string, string> = {
  UNETLoader: 'unet_name',
  CheckpointLoaderSimple: 'ckpt_name',
  CheckpointLoader: 'ckpt_name',
  CLIPLoader: 'clip_name',
  DualCLIPLoader: 'clip_name1', // best effort; surfaces one of the two
  VAELoader: 'vae_name',
}

/** A widget value is a scalar; an input link is a 2-element list [node_id, slot]. */
function isWidgetValue(v: any): boolean {
  return !isLink(v)
}

/**
 * Pull widget-only defaults from the sampler + latent nodes. Linked inputs (fed
 * by upstream nodes) are skipped — overriding the widget would have no effect.
 */
export function extractDefaults(
  api: Record<string, any>,
  samplerId: string | null,
  latentId: string | null
): Record<string, any> {
  const out: Record<string, any> = {}
  if (samplerId && samplerId in api) {
    const samplerInputs = api[samplerId]?.inputs ?? {}
    for (const k of SAMPLER_WIDGET_KEYS) {
      if (k in samplerInputs && isWidgetValue(samplerInputs[k])) out[k] = samplerInputs[k]
    }
  }
  if (latentId && latentId in api) {
    const latentInputs = api[latentId]?.inputs ?? {}
    for (const k of LATENT_WIDGET_KEYS) {
      if (k in latentInputs && isWidgetValue(latentInputs[k])) out[k] = latentInputs[k]
    }
  }
  return out
}

/**
 * Return a human-readable model summary by joining loader-node filenames.
 * Returns '(no loader nodes)' when none are found.
 */
export function extractModelSummary(api: Record<string, any>): string {
  const parts: string[] = []
  for (const nid of sortedNodeIds(api)) {
    const node = api[nid]
    const widgetKey = LOADER_KEY_BY_CLASS[node?.class_type]
    if (widgetKey === undefined) continue
    const val = node?.inputs?.[widgetKey]
    if (typeof val === 'string' && val) parts.push(val)
  }
  if (parts.length === 0) return '(no loader nodes)'
  return parts.join(' + ')
}

/** True iff any node's inputs link to either output slot of targetId. */
function referencesTo(api: Record<string, any>, targetId: string): boolean {
  for (const [nid, node] of Object.entries(api)) {
    if (nid === targetId) continue
    const inputs = (node as any)?.inputs ?? {}
    for (const v of Object.values(inputs)) {
      if (isLink(v) && String((v as any[])[0]) === targetId) return true
    }
  }
  return false
}

/**
 * Identify LoraLoader nodes and classify them.
 * - pool: dangling LoraLoaders forming the agent-selectable pool (empty if locked)
 * - locked: true if >=1 LoraLoader is wired into the main path
 * - lockedIds: node ids of the wired LoraLoaders
 */
export function scanLoraPool(api: Record<string, any>): {
  pool: AvailableLora[]
  locked: boolean
  lockedIds: string[]
} {
  const wiredIds: string[] = []
  const candidateIds: string[] = []
  for (const nid of sortedNodeIds(api)) {
    if (api[nid]?.class_type !== 'LoraLoader') continue
    if (referencesTo(api, nid)) wiredIds.push(nid)
    else candidateIds.push(nid)
  }

  if (wiredIds.length > 0) return { pool: [], locked: true, lockedIds: wiredIds }

  const pool: AvailableLora[] = []
  for (const nid of candidateIds) {
    const inputs = api[nid]?.inputs ?? {}
    const name = inputs.lora_name
    const sm = inputs.strength_model
    const sc = inputs.strength_clip
    // Require all three widget values to be valid scalars.
    if (typeof name !== 'string' || !name) continue
    // Explicitly exclude booleans (JS typeof true === 'boolean', not 'number',
    // but be defensive to match the Python semantics).
    if (typeof sm === 'boolean' || typeof sc === 'boolean') continue
    if (typeof sm !== 'number' || typeof sc !== 'number') continue
    pool.push({ name, nodeId: nid, strengthModel: sm, strengthClip: sc })
  }
  return { pool, locked: false, lockedIds: [] }
}

/**
 * Resolve a link, transparently walking through any LoraLoader hops.
 * `inputKey` is the upstream input on a LoraLoader to follow ("model" or "clip").
 * Stops at the first non-LoraLoader node. Returns [nodeId, slot] or null.
 */
function followThroughLoraLoader(
  api: Record<string, any>,
  link: any,
  inputKey: string
): [string, number] | null {
  const seen = new Set<string>()
  let current = link
  while (true) {
    if (!isLink(current)) return null
    const nid = String(current[0])
    if (seen.has(nid)) return null // cycle
    seen.add(nid)
    const node = api[nid]
    if (node === undefined) return null
    if (node?.class_type !== 'LoraLoader') {
      const slot = current[1]
      if (typeof slot !== 'number' || !Number.isInteger(slot)) return null
      return [nid, slot]
    }
    // LoraLoader: follow upstream on the requested input key.
    const next = node?.inputs?.[inputKey]
    if (next === undefined || next === null) return null
    current = next
  }
}

/**
 * Return [nodeId, slot] for the upstream model provider of the sampler.
 * Walks through any LoraLoader hops. Null if the chain cannot be resolved.
 */
export function traceModelSource(
  api: Record<string, any>,
  samplerId: string
): [string, number] | null {
  const sampler = api[samplerId]
  if (sampler === undefined) return null
  const link = sampler?.inputs?.model
  return followThroughLoraLoader(api, link, 'model')
}

/** Return [nodeId, slot] for the upstream clip provider of the positive prompt node. */
export function traceClipSource(
  api: Record<string, any>,
  positiveId: string
): [string, number] | null {
  const pos = api[positiveId]
  if (pos === undefined) return null
  const link = pos?.inputs?.clip
  return followThroughLoraLoader(api, link, 'clip')
}

export const ASPECT_RATIO_MAP: Record<string, [number, number]> = {
  // NORMAL tier (~1 MP, SDXL standard buckets) — bare names default here
  portrait: [832, 1216],
  landscape: [1216, 832],
  square: [1024, 1024],
  // LARGE tier (~1.5–2 MP)
  large_portrait: [1024, 1536],
  large_landscape: [1536, 1024],
  large_square: [1472, 1472],
  // SMALL tier (fast / low-res drafts)
  small_portrait: [512, 768],
  small_landscape: [768, 512],
  small_square: [640, 640],
}

export interface OverrideArgs {
  prompt: string
  negative?: string | null
  aspectRatio?: string | null
  width?: number | null
  height?: number | null
  steps?: number | null
  cfg?: number | null
  seed: number // required; caller randomises null into an int
  loras?: Array<{ name: string; strengthModel?: number; strengthClip?: number }> | null
}

/** Set node.inputs[key] = value, but skip + warn if current value is a link. */
function setWidgetOrWarn(nodeId: string, node: any, key: string, value: any): void {
  if (!node.inputs) node.inputs = {}
  const current = node.inputs[key]
  if (isLink(current)) {
    console.warn(`comfyui: node ${nodeId}: cannot override ${key} — it's linked, not a widget`)
    return
  }
  node.inputs[key] = value
}

/**
 * Deep-copy the template's raw API-format object, apply overrides, return it.
 *
 * `seed` is required (caller randomises null into an int beforehand). Other
 * fields fall back to template defaults when null/undefined.
 *
 * Size precedence: explicit width/height > aspectRatio > template default.
 * width and height must be passed together; caller validates them.
 *
 * `loras`: optional list of {name, strengthModel?, strengthClip?}. Each name must
 * already have been validated against t.availableLoras by the caller. When
 * non-empty, the selected dangling LoraLoader nodes are wired into the main path
 * in agent-given order, and downstream references to modelSource/clipSource are
 * redirected to the chain's tail.
 */
export function applyOverrides(t: TemplateBindings, args: OverrideArgs): Record<string, any> {
  const { prompt, seed } = args
  const negative = args.negative ?? null
  const aspectRatio = args.aspectRatio ?? null
  const width = args.width ?? null
  const height = args.height ?? null
  const steps = args.steps ?? null
  const cfg = args.cfg ?? null
  const loras = args.loras ?? null

  const out: Record<string, any> = structuredClone(t.raw)

  // prompt (replace, never append)
  setWidgetOrWarn(t.positiveNode, out[t.positiveNode], 'text', prompt)

  // negative (only override when explicitly given)
  if (negative !== null && t.negativeNode) {
    setWidgetOrWarn(t.negativeNode, out[t.negativeNode], 'text', negative)
  }

  // KSampler widgets
  if (t.samplerNode && t.samplerNode in out) {
    setWidgetOrWarn(t.samplerNode, out[t.samplerNode], 'seed', seed)
    if (steps !== null) setWidgetOrWarn(t.samplerNode, out[t.samplerNode], 'steps', steps)
    if (cfg !== null) setWidgetOrWarn(t.samplerNode, out[t.samplerNode], 'cfg', cfg)
  }

  // width/height (explicit) takes precedence over aspectRatio
  if (width !== null && height !== null) {
    if (aspectRatio !== null) {
      console.warn('comfyui: both width/height and aspect_ratio given; using explicit width/height')
    }
    if (t.latentNode && t.latentNode in out) {
      setWidgetOrWarn(t.latentNode, out[t.latentNode], 'width', width)
      setWidgetOrWarn(t.latentNode, out[t.latentNode], 'height', height)
    } else {
      console.warn('comfyui: width/height requested but template has no EmptyLatentImage node; ignoring')
    }
  } else if (aspectRatio !== null) {
    if (!(aspectRatio in ASPECT_RATIO_MAP)) {
      console.warn(`comfyui: unknown aspect_ratio ${JSON.stringify(aspectRatio)}; using template default`)
    } else if (t.latentNode && t.latentNode in out) {
      const [w, h] = ASPECT_RATIO_MAP[aspectRatio]
      setWidgetOrWarn(t.latentNode, out[t.latentNode], 'width', w)
      setWidgetOrWarn(t.latentNode, out[t.latentNode], 'height', h)
    } else {
      console.warn(
        `comfyui: aspect_ratio=${JSON.stringify(aspectRatio)} requested but template has no EmptyLatentImage node; ignoring`
      )
    }
  }

  // LoRA chain wiring
  if (loras && loras.length > 0) {
    applyLoraChain(out, t, loras)
  }

  return out
}

/**
 * Wire selected dangling LoraLoaders into the main path, in agent-given order.
 * Assumes caller has validated: template not locked, modelSource/clipSource both
 * set, each name appears in availableLoras at most once.
 */
function applyLoraChain(
  out: Record<string, any>,
  t: TemplateBindings,
  loras: NonNullable<OverrideArgs['loras']>
): void {
  if (t.modelSource === null || t.clipSource === null) {
    console.warn('comfyui: apply_overrides: missing model/clip source; skipping LoRA wiring')
    return
  }

  const byName = new Map(t.availableLoras.map((al) => [al.name, al]))
  const chain: AvailableLora[] = []
  for (const entry of loras) {
    const al = byName.get(entry.name)
    if (al === undefined) {
      console.warn(
        `comfyui: apply_overrides: lora ${JSON.stringify(entry.name)} missing from pool; skipping`
      )
      continue
    }
    chain.push(al)
  }
  if (chain.length === 0) return

  const mSrc = t.modelSource
  const cSrc = t.clipSource

  // Wire L0 .. Lk
  for (let i = 0; i < chain.length; i++) {
    const al = chain[i]
    const node = out[al.nodeId]
    if (!node.inputs) node.inputs = {}
    if (i === 0) {
      node.inputs.model = [mSrc[0], mSrc[1]]
      node.inputs.clip = [cSrc[0], cSrc[1]]
    } else {
      node.inputs.model = [chain[i - 1].nodeId, 0]
      node.inputs.clip = [chain[i - 1].nodeId, 1]
    }
    const entry = loras[i]
    if (entry.strengthModel !== undefined && entry.strengthModel !== null) {
      node.inputs.strength_model = entry.strengthModel
    }
    if (entry.strengthClip !== undefined && entry.strengthClip !== null) {
      node.inputs.strength_clip = entry.strengthClip
    }
  }

  const tailId = chain[chain.length - 1].nodeId
  const chainIds = new Set(chain.map((al) => al.nodeId))

  // Redirect every other node's inputs that referenced modelSource / clipSource.
  for (const [nid, node] of Object.entries(out)) {
    if (chainIds.has(nid)) continue
    const inputs = (node as any)?.inputs
    if (typeof inputs !== 'object' || inputs === null) continue
    for (const [k, v] of Object.entries(inputs)) {
      if (!isLink(v)) continue
      const slot = (v as any[])[1]
      if (typeof slot !== 'number' || !Number.isInteger(slot)) continue
      const link: [string, number] = [String((v as any[])[0]), slot]
      if (link[0] === mSrc[0] && link[1] === mSrc[1]) {
        inputs[k] = [tailId, 0]
      } else if (link[0] === cSrc[0] && link[1] === cSrc[1]) {
        inputs[k] = [tailId, 1]
      }
    }
  }
}

/**
 * Load + heuristic-extract one template from its JSON text.
 * Assembles loadRaw -> find* -> extract* -> scanLoraPool -> trace*, applying the
 * locked / suppress-pool logic. Raises TemplateLoadError on failure.
 */
export function loadTemplate(name: string, jsonText: string): TemplateBindings {
  const api = loadRaw(jsonText, name)
  const samplerId = findSamplerNode(api)
  const latentId = findLatentNode(api)
  const [posId, negId] = findPromptNodes(api, samplerId)

  const seedPrompt = nodeText(api[posId])
  const seedNegative = negId ? nodeText(api[negId]) : ''
  const defaults = extractDefaults(api, samplerId, latentId)
  const summary = extractModelSummary(api)

  const { pool: scannedPool, locked, lockedIds } = scanLoraPool(api)
  const modelSource = samplerId ? traceModelSource(api, samplerId) : null
  const clipSource = traceClipSource(api, posId)

  let pool = scannedPool
  let loraLockReason: string | null = null
  if (locked) {
    loraLockReason = `template has pre-wired LoraLoader node(s): ${JSON.stringify(lockedIds)}`
  } else if (pool.length > 0 && (modelSource === null || clipSource === null)) {
    console.warn(
      `comfyui: ${name}: dangling LoraLoader pool found but model/clip source could not be ` +
        `traced; suppressing pool. modelSource=${JSON.stringify(modelSource)} clipSource=${JSON.stringify(clipSource)}`
    )
    pool = []
    loraLockReason = 'cannot resolve model/clip source'
  }

  return {
    name,
    positiveNode: posId,
    negativeNode: negId,
    samplerNode: samplerId,
    latentNode: latentId,
    seedPrompt,
    seedNegative,
    defaults,
    modelSummary: summary,
    raw: api,
    availableLoras: pool,
    modelSource,
    clipSource,
    loraLocked: locked,
    loraLockReason,
  }
}

/**
 * Scan a directory for *.json templates and load each. Per-file failures are
 * warned and skipped. Duplicate stems are warned and the later one skipped.
 * Returns an empty array if the directory does not exist.
 */
export function scanWorkflowTemplates(
  dir: string,
  opts?: { server?: string }
): TemplateBindings[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
  const out: TemplateBindings[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const stem = parsePath(file).name
    try {
      const text = readFileSync(join(dir, file), 'utf-8')
      const t = loadTemplate(stem, text)
      if (seen.has(stem)) {
        console.warn(`comfyui: duplicate template name ${JSON.stringify(stem)}; skipping ${file}`)
        continue
      }
      seen.add(stem)
      if (opts?.server !== undefined) t.server = opts.server
      out.push(t)
    } catch (e) {
      console.warn(`comfyui: skipping unloadable template ${file}: ${e}`)
    }
  }
  return out
}

/** Scan a directory for *.md guides. Returns { name: stem, content }[]. */
export function scanGuides(dir: string): Guide[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
  const out: Guide[] = []
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8')
      out.push({ name: parsePath(file).name, content })
    } catch (e) {
      console.warn(`comfyui: skipping unreadable guide ${file}: ${e}`)
    }
  }
  return out
}
