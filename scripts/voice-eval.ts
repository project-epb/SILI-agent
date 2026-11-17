/**
 * Chat voice check: send a fixed set of messages through a persona's full
 * system prompt and print the replies, without QQ or Koishi.
 *
 *   npx tsx scripts/voice-eval.ts [--persona SILI-v7.prompt.md]
 *     [--model <provider>[#<model>]] [--cases scripts/voice-eval.cases.txt]
 *
 * Provider settings come from `.env` (LLM_PROVIDER_N_*), default provider from
 * LLM_DEFAULT_PROVIDER. Only `openai`-type providers are supported. Node's
 * fetch ignores proxy variables, so overseas providers may need a proxy.
 *
 * Cases are separated by blank lines; each line of a case is one user turn,
 * so a multi-line case is a conversation. Lines starting with `#` are comments.
 * No tools are offered: this checks how the persona talks, not what it can do.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { parseArgs } from 'node:util'

import OpenAI from 'openai'

import { buildSystemPromptText } from '../src/plugins/llm/services/system-prompt'
import { PROTOCOL_MARKERS, PROTOCOL_TAGS } from '../src/plugins/llm/utils/protocol'
import { parseLLMProviders } from '../src/utils/parseLLMProviders'

const ROOT = resolve(__dirname, '..')
const PROMPTS = resolve(ROOT, 'src/plugins/llm/prompts')
const CONCURRENCY = 5

const { values: args } = parseArgs({
  options: {
    persona: { type: 'string', default: 'SILI-v7.prompt.md' },
    model: { type: 'string' },
    cases: { type: 'string', default: resolve(ROOT, 'scripts/voice-eval.cases.txt') },
  },
})

loadEnvFile(resolve(ROOT, '.env'))

const readPrompt = (file: string) =>
  readFileSync(resolve(PROMPTS, file), 'utf-8').trim()

// Same composition as PluginLLM.readPersonaPrompt + buildSystemPromptText,
// minus the command catalog (no tools here).
const systemPrompt = buildSystemPromptText(
  [readPrompt(args.persona!), readPrompt('IM-voice.prompt.md')].join('\n\n'),
  ''
)

const providers = parseLLMProviders(process.env)
const [providerName, modelOverride] = (args.model ?? '').split('#')
const provider = providerName
  ? providers.find((p) => p.name === providerName)
  : providers[0]
if (!provider) throw new Error(`provider "${providerName}" not found in .env`)
if (provider.type !== 'openai') {
  throw new Error(`provider "${provider.name}" is ${provider.type}; only openai-type is supported`)
}
const options = (provider as any).options ?? {}
const model = modelOverride || (provider as any).model || options.model
const client = new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey })

function envelope(text: string) {
  const turnContext = {
    koishi: { uid: 100, callme: '', authority: 1 },
    platform: {
      kind: 'qq',
      user: { id: 'EVALUSER', name: '路人甲' },
      channel: { id: 'EVALGROUP', name: '测试群', type: 0 },
    },
    time: new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }) + ' (Asia/Shanghai)',
  }
  return [
    PROTOCOL_TAGS.TURN_CONTEXT.open,
    JSON.stringify(turnContext),
    PROTOCOL_TAGS.TURN_CONTEXT.close,
    PROTOCOL_TAGS.USER_MESSAGE.open,
    text,
    PROTOCOL_TAGS.USER_MESSAGE.close,
  ].join('\n')
}

async function runCase(turns: string[]) {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ]
  const out: string[] = []
  for (const turn of turns) {
    messages.push({ role: 'user', content: envelope(turn) })
    const res = await client.chat.completions.create({ model, messages })
    const reply = res.choices[0]?.message?.content ?? ''
    messages.push({ role: 'assistant', content: reply })
    out.push(`> ${turn}`)
    for (const part of reply.split(PROTOCOL_MARKERS.MSG_BREAK)) {
      if (part.trim()) out.push(part.trim().replace(/^/gm, '    '))
    }
  }
  return out.join('\n')
}

async function main() {
  const cases = readFileSync(args.cases!, 'utf-8')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    )
    .filter((turns) => turns.length)

  console.log(`# ${args.persona} · ${provider!.name}#${model} · ${cases.length} cases\n`)
  const results: string[] = new Array(cases.length)
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cases.length) {
        const i = next++
        results[i] = await runCase(cases[i]).catch((e) => `> ${cases[i][0]}\n    [error] ${e.message}`)
      }
    })
  )
  console.log(results.join('\n\n'))
}

main()
