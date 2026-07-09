import type { Logger } from '@koishijs/core'

import type { ToolDefinition } from '../providers/_base'
import {
  CodeSandboxRuntime,
  type CodeSandboxResult,
  type CodeSandboxRuntimeConfig,
} from '../services/code-sandbox-runtime'

import type { ToolHandler } from './types'

export const CODE_SANDBOX_TOOL: ToolDefinition = {
  name: 'run_code_sandbox',
  description: [
    '在隔离 JS 沙箱里运行一段代码做数学/数据处理类工作。**不联网、不读盘**。',
    '',
    '**入口契约**：必须定义且只定义一个 `function main() {}`，sync / async 均可。',
    '`return` 的值会被序列化展示给用户；过程信息用 console.log/warn/error。',
    '',
    '**沙箱环境**：',
    '- 语言能力：QuickJS（WASM），最高支持到 **ES2023**（async/await、BigInt、Proxy、可选链、Promise.allSettled 等可用；ES2024+ 的特性如 Temporal、Array Grouping 不可用）',
    '- 全局可用：标准内建对象（Math / Date / JSON / Array / Object / Map / Set / Promise / RegExp / BigInt 等）+ 注入的 `console`',
    '- **没有任何第三方库**（mathjs / dayjs / lodash 都不可用）；复杂算法请自己实现',
    '- 沙箱内**没有** fetch / XHR / WebSocket / setTimeout / setInterval / process / require / Bun / Deno',
    '- 可 `await` 立即 resolved 的 Promise / async 函数，但没有 host 异步源',
    '',
    '**何时调**：数值/统计计算、单位/进制转换、JSON/CSV 解析与转换、日期运算、文本批处理、需要程序化验证的逻辑。',
    '**何时别调**：能直接答的事实问题、能用 web_search/extract_webpages 解决的联网查询。',
    '**用户看不到你写的代码、运行过程、结果**：若有需要，自己转述给用户。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          '完整 JS 源码，必须包含 `function main() {}` 入口（sync / async 均可）',
      },
      timeout_ms: {
        type: 'integer',
        description: '执行超时（ms），默认 3000，上限 10000',
        minimum: 100,
        maximum: 10000,
      },
    },
    required: ['code'],
    additionalProperties: false,
  },
}

export interface CodeSandboxToolInput {
  code: string
  timeout_ms?: number
}

export function renderCodeSandboxResult(r: CodeSandboxResult): string {
  const parts: string[] = []
  if (r.stdout) {
    parts.push('### stdout', '```', r.stdout.replace(/\n$/, ''), '```')
  }
  if (r.errorMessage) {
    parts.push(r.errorMessage)
  } else if (r.returnValue !== undefined) {
    parts.push('### return', '```', r.returnValue, '```')
  } else if (!r.stdout) {
    parts.push('(no output)')
  }
  parts.push(`_(${r.durationMs}ms)_`)
  return parts.join('\n')
}

export function buildCodeSandboxHandler(
  logger: Logger,
  config: CodeSandboxRuntimeConfig = {}
): ToolHandler {
  const runtime = new CodeSandboxRuntime(logger, config)
  return {
    definition: CODE_SANDBOX_TOOL,
    async execute(args) {
      const input = args as CodeSandboxToolInput
      if (!input?.code || typeof input.code !== 'string') {
        return 'Error: tool input missing required field "code"'
      }
      const result = await runtime.run(input.code, {
        timeoutMs: input.timeout_ms,
      })
      return renderCodeSandboxResult(result)
    },
  }
}
