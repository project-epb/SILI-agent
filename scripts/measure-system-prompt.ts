/**
 * System-prompt size baseline.
 *
 * Reports byte / char totals for each piece that ends up in the static
 * prefix sent to the model on every turn:
 *   - base prompt (SILI-v5 persona)
 *   - 6 hardcoded sections in buildSystemPromptText
 *   - 5 tool definitions (name + description + JSONified parameter schema)
 *
 * Catalog is dynamic and depends on registered commands; we sample the
 * hardcoded sections in isolation so before/after slimming comparisons
 * are stable. Run with:
 *
 *   npx tsx scripts/measure-system-prompt.ts
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildSystemPromptText } from '../src/plugins/llm/services/system-prompt'
import {
  EXECUTE_KOISHI_COMMAND_TOOL,
  READ_USER_MEMORY_TOOL,
  buildSaveUserMemoryTool,
  WEB_SEARCH_TOOL,
  EXTRACT_WEBPAGES_TOOL,
} from '../src/plugins/llm/tools'

const PROMPTS_DIR = resolve(
  __dirname,
  '../src/plugins/llm/prompts'
)

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function chars(s: string): number {
  return [...s].length
}

function row(label: string, text: string, totalBytes: number): string {
  const b = bytes(text)
  const c = chars(text)
  const pct = totalBytes ? ((b / totalBytes) * 100).toFixed(1) : '—'
  return `${label.padEnd(40)} ${String(b).padStart(7)} B   ${String(c).padStart(6)} ch   ${pct.padStart(5)}%`
}

const basePrompt = readFileSync(
  resolve(PROMPTS_DIR, 'SILI-v5.prompt.md'),
  'utf8'
)

// Build the full prompt with empty catalog so we isolate the hardcoded
// sections. Then build with a marker catalog to see catalog scaffolding
// cost (the "调用工具" block only appears when catalog is non-empty).
const fullEmpty = buildSystemPromptText(basePrompt, '')
const fullWithCatalog = buildSystemPromptText(basePrompt, '<CATALOG>')
// Strip the catalog marker out to leave only the catalog-scaffolding
// section ("## 调用工具" + the line below) plus everything in fullEmpty.
const scaffoldingDelta = bytes(fullWithCatalog) - bytes(fullEmpty) - bytes('<CATALOG>\n\n')

const tools = [
  EXECUTE_KOISHI_COMMAND_TOOL,
  READ_USER_MEMORY_TOOL,
  buildSaveUserMemoryTool({ private: 3300, shared: 3300, group: 3300 }),
  WEB_SEARCH_TOOL,
  EXTRACT_WEBPAGES_TOOL,
]

const toolSerialized = tools
  .map((t) => JSON.stringify(t))
  .join('\n')

const total = bytes(fullWithCatalog) + bytes(toolSerialized)

console.log('# System-prompt static prefix baseline\n')
console.log(`(prefix sent on every turn = system prompt + tool defs; catalog is dynamic and excluded from totals.)\n`)

console.log('## Base prompt (SILI persona)')
console.log(row('SILI-v5.prompt.md', basePrompt, total))
console.log()

console.log('## buildSystemPromptText output (basePrompt + empty catalog)')
console.log(row('full prompt body, no catalog', fullEmpty, total))
console.log(`  ↑ minus base prompt = ${bytes(fullEmpty) - bytes(basePrompt)} B of hardcoded sections + glue`)
console.log()

console.log('## Catalog scaffolding cost')
console.log(`  "## 调用工具" + hints ≈ ${scaffoldingDelta} B (added when catalog non-empty)`)
console.log()

console.log('## Tool definitions (description + JSON schema)')
let toolTotal = 0
for (const t of tools) {
  const json = JSON.stringify(t)
  toolTotal += bytes(json)
  console.log(row(`  ${t.name}`, json, total))
}
console.log(row('  (tool defs subtotal)', toolSerialized, total))
console.log()

console.log('## TOTAL static prefix (system prompt + tool defs)')
console.log(`  ${total} B   |   ${chars(fullWithCatalog) + chars(toolSerialized)} ch`)
console.log()
console.log('---')
console.log('Notes:')
console.log('- Bytes ≈ UTF-8 wire size. Tokens are roughly bytes/3 for CJK-heavy,')
console.log('  bytes/4 for ASCII-heavy text, but providers differ — treat as relative.')
console.log('- The dynamic command catalog is excluded; it scales with how many')
console.log('  koishi commands are registered (typically 2–5 KB).')
