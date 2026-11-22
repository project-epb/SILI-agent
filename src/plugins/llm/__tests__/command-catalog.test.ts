// From @koishijs/core, never 'koishi': importing koishi under vitest loads
// @koishijs/loader, which crashes at import time and fails the whole file.
import { Context } from '@koishijs/core'

import { describe, expect, it } from 'vitest'

import {
  type CommandCatalogEntry,
  buildCommandCatalog,
  findCatalogEntry,
  projectHideForHuman,
  renderCatalogEntryDetail,
  renderCommandCatalog,
  renderCompactCatalog,
} from '../utils/command-catalog'

describe('renderCommandCatalog', () => {
  it('renders empty catalog', () => {
    const out = renderCommandCatalog([])
    expect(out).toContain('## 可用指令')
    expect(out).toMatch(/(暂无|none)/i)
  })

  it('renders single root command', () => {
    const entries: CommandCatalogEntry[] = [
      {
        name: 'help',
        description: '显示帮助',
        args: [],
        options: [],
        aliases: [],
        children: [],
      },
    ]
    const out = renderCommandCatalog(entries)
    expect(out).toContain('help — 显示帮助')
  })

  it('renders args with type and required', () => {
    const entries: CommandCatalogEntry[] = [
      {
        name: 'pixiv.illust',
        description: '获取插画',
        args: [
          { name: 'id', type: 'posint', required: true, description: '插画ID' },
        ],
        options: [],
        aliases: [],
        children: [],
      },
    ]
    const out = renderCommandCatalog(entries)
    expect(out).toContain('pixiv.illust <id>')
    expect(out).toContain('id(posint, 插画ID)')
  })

  it('renders options', () => {
    const entries: CommandCatalogEntry[] = [
      {
        name: 'foo',
        description: 'foo cmd',
        args: [],
        options: [
          { name: 'verbose', type: 'boolean', description: '详细输出' },
        ],
        aliases: [],
        children: [],
      },
    ]
    const out = renderCommandCatalog(entries)
    expect(out).toContain('verbose(详细输出)')
  })

  it('renders aliases', () => {
    const entries: CommandCatalogEntry[] = [
      {
        name: 'sticker',
        description: '生成表情包',
        args: [],
        options: [],
        aliases: ['表情包'],
        children: [],
      },
    ]
    const out = renderCommandCatalog(entries)
    expect(out).toContain('别名: 表情包')
  })

  it('indents children', () => {
    const entries: CommandCatalogEntry[] = [
      {
        name: 'sticker',
        description: '表情包',
        args: [],
        options: [],
        aliases: [],
        children: [
          {
            name: 'sticker.cat',
            description: '猫表情',
            args: [],
            options: [],
            aliases: [],
            children: [],
          },
        ],
      },
    ]
    const out = renderCommandCatalog(entries)
    const catLine = out.split('\n').find((l) => l.includes('sticker.cat'))
    expect(catLine).toMatch(/^\s{2}/)
  })
})

describe('renderCompactCatalog', () => {
  const empty: CommandCatalogEntry[] = []
  const sample: CommandCatalogEntry[] = [
    {
      name: 'help',
      description: '显示帮助',
      args: [{ name: 'command', type: 'string', required: false }],
      options: [],
      aliases: [],
      children: [],
    },
    {
      name: 'pixiv.illust',
      description: '获取插画',
      args: [{ name: 'id', type: 'posint', required: true }],
      options: [{ name: 'raw', type: 'boolean', description: '原图' }],
      aliases: ['p.i'],
      children: [],
    },
    {
      name: 'sticker',
      description: '生成贴纸',
      args: [],
      options: [],
      aliases: ['UNIQUE_ALIAS_X'],
      children: [
        {
          name: 'sticker.cat',
          description: '猫贴纸',
          args: [],
          options: [],
          aliases: [],
          children: [],
        },
      ],
    },
  ]

  it('renders empty placeholder', () => {
    const out = renderCompactCatalog(empty)
    expect(out).toContain('## 可用指令')
    expect(out).toMatch(/暂无/)
  })

  it('emits one bullet per top-level command', () => {
    const out = renderCompactCatalog(sample)
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('`help`')
    expect(lines[1]).toContain('`pixiv.illust`')
    expect(lines[2]).toContain('`sticker`')
  })

  it('does not include args, options, aliases, or children', () => {
    const out = renderCompactCatalog(sample)
    expect(out).not.toContain('参数')
    expect(out).not.toContain('选项')
    expect(out).not.toContain('--raw')
    expect(out).not.toContain('原图')
    expect(out).not.toContain('p.i')
    expect(out).not.toContain('别名')
    expect(out).not.toContain('UNIQUE_ALIAS_X')
    expect(out).not.toContain('sticker.cat')
    expect(out).not.toContain('猫贴纸')
  })

  it('substitutes a placeholder for missing description', () => {
    const out = renderCompactCatalog([
      {
        name: 'foo',
        description: '',
        args: [],
        options: [],
        aliases: [],
        children: [],
      },
    ])
    expect(out).toContain('`foo`')
    expect(out).toContain('(无描述)')
  })

  it('compact output is dramatically shorter than verbose for the same input', () => {
    const verbose = renderCommandCatalog(sample)
    const compact = renderCompactCatalog(sample)
    expect(compact.length).toBeLessThan(verbose.length)
  })
})

describe('findCatalogEntry', () => {
  const catalog: CommandCatalogEntry[] = [
    {
      name: 'wiki',
      description: 'wiki cmd',
      args: [],
      options: [],
      aliases: [],
      children: [
        {
          name: 'wiki.connect',
          description: 'connect',
          args: [],
          options: [],
          aliases: [],
          children: [],
        },
        {
          name: 'wiki.search',
          description: 'search',
          args: [],
          options: [],
          aliases: [],
          children: [],
        },
      ],
    },
    {
      name: 'help',
      description: 'show help',
      args: [],
      options: [],
      aliases: [],
      children: [],
    },
  ]

  it('finds top-level entries by exact name', () => {
    expect(findCatalogEntry(catalog, 'wiki')?.name).toBe('wiki')
    expect(findCatalogEntry(catalog, 'help')?.name).toBe('help')
  })

  it('finds nested entries by exact name', () => {
    expect(findCatalogEntry(catalog, 'wiki.connect')?.name).toBe('wiki.connect')
    expect(findCatalogEntry(catalog, 'wiki.search')?.description).toBe('search')
  })

  it('returns null for unknown', () => {
    expect(findCatalogEntry(catalog, 'nope')).toBeNull()
    expect(findCatalogEntry(catalog, 'wiki connect')).toBeNull() // 含空格不匹配
  })
})

describe('renderCatalogEntryDetail', () => {
  it('renders heading, description, args, options, aliases, children', () => {
    const entry: CommandCatalogEntry = {
      name: 'wiki',
      description: 'MediaWiki 工具',
      args: [
        {
          name: 'titles',
          type: 'string',
          required: false,
          description: '页面',
        },
      ],
      options: [
        { name: 'details', type: 'boolean', description: '详情' },
        { name: 'search', type: 'boolean' },
      ],
      aliases: ['维基'],
      children: [
        {
          name: 'wiki.connect',
          description: '连接群与 wiki',
          args: [],
          options: [],
          aliases: [],
          children: [],
        },
      ],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('# wiki [titles]')
    expect(out).toContain('MediaWiki 工具')
    expect(out).toContain('## 参数')
    expect(out).toContain('`titles`')
    expect(out).toContain('## 选项')
    expect(out).toContain('`details` (boolean)')
    expect(out).toContain('## 别名')
    expect(out).toContain('维基')
    expect(out).toContain('## 子指令')
    expect(out).toContain('`wiki.connect`')
    // 不能出现 koishi 风格的空格分隔子指令
    expect(out).not.toMatch(/wiki connect/)
  })

  it('renders usage block between description and 参数', () => {
    const entry: CommandCatalogEntry = {
      name: 'dice',
      description: '掷骰子',
      usage:
        '投掷 [骰子表达式] [--difficulty 难度值]\n例如"两个20面骰加5"：dice 2d20+5',
      args: [{ name: 'dice', type: 'string', required: false }],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('## 用法')
    expect(out).toContain('投掷 [骰子表达式]')
    expect(out).toContain('例如"两个20面骰加5"')
    // 用法必须在 描述 之后、参数 之前
    expect(out.indexOf('掷骰子')).toBeLessThan(out.indexOf('## 用法'))
    expect(out.indexOf('## 用法')).toBeLessThan(out.indexOf('## 参数'))
  })

  it('renders option keys as declared for the JSON payload', () => {
    const entry: CommandCatalogEntry = {
      name: 'dice',
      description: 'd',
      args: [],
      options: [
        {
          name: 'difficultyLevel',
          type: 'string',
          description: '难度值',
        },
      ],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('`difficultyLevel` (string) — 难度值')
    expect(out).not.toContain('--difficulty-level')
  })

  it('omits empty sections', () => {
    const entry: CommandCatalogEntry = {
      name: 'foo',
      description: '一个简单指令',
      args: [],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('# foo')
    expect(out).toContain('一个简单指令')
    expect(out).not.toContain('## 参数')
    expect(out).not.toContain('## 选项')
    expect(out).not.toContain('## 别名')
    expect(out).not.toContain('## 子指令')
  })

  it('uses required-vs-optional brackets in heading', () => {
    const entry: CommandCatalogEntry = {
      name: 'foo',
      description: 'd',
      args: [
        { name: 'a', type: 'string', required: true },
        { name: 'b', type: 'string', required: false },
      ],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('# foo <a> [b]')
  })
})

// ---- fake koishi ctx/command factories for buildCommandCatalog ----
function makeCmd(over: any = {}): any {
  return {
    name: over.name ?? 'cmd',
    displayName: over.displayName,
    config: over.config ?? {},
    locale: '',
    _description: over._description ?? '',
    _usage: over._usage,
    _arguments: over._arguments ?? [],
    _options: over._options ?? {},
    _aliases: over._aliases ?? {},
    children: over.children ?? [],
    parent: over.parent ?? null,
    _root: undefined,
  }
}
function makeCtx(commands: any[]): any {
  return {
    $commander: { _commandList: commands },
    i18n: { render: () => [] },
  }
}

describe('buildCommandCatalog: order', () => {
  it('renders the same catalog whatever order commands registered in', () => {
    const build = (names: string[]) => {
      const app = new Context()
      for (const n of names) app.command(n, `${n} desc`)
      return renderCompactCatalog(buildCommandCatalog(app))
    }
    expect(build(['wiki', 'dice', 'wiki.search', 'wiki.connect'])).toBe(
      build(['dice', 'wiki', 'wiki.connect', 'wiki.search'])
    )
    const app = new Context()
    app.command('wiki.search')
    app.command('wiki.connect')
    const [wiki] = buildCommandCatalog(app)
    expect(wiki.children.map((c) => c.name)).toEqual(['wiki.connect', 'wiki.search'])
  })
})

describe('buildCommandCatalog: Koishi help metadata', () => {
  it('uses registered examples and skips missing translations and injected help options', () => {
    const app = new Context()
    app
      .command('sample', '示例指令')
      .option('difficultyLevel', '-d <level:number> 难度')
      .option('plain', '-p')
      .option('help', '-h', {
        hidden: true,
        descPath: 'commands.help.options.help',
      })
      .example('sample -d 2')
      .example('sample -p')
    app.i18n.define('zh-CN', 'commands.sample.examples', '较低优先级的示例')
    const [entry] = buildCommandCatalog(app)
    const detail = renderCatalogEntryDetail(entry)
    expect(detail).toContain('`difficultyLevel` (number) — 难度')
    expect(detail).toContain('`plain` (boolean)')
    expect(detail).toContain('## 示例\nsample -d 2\n\nsample -p')
    expect(detail).not.toMatch(/commands\.|## 用法|`help`|较低优先级/)
  })

  it('reads localized examples when no inline examples are registered', () => {
    const app = new Context()
    app.command('sample', '示例指令').usage('选择一种用法')
    app.i18n.define(
      'zh-CN',
      'commands.sample.examples',
      'sample one\nsample two'
    )
    const [entry] = buildCommandCatalog(app)
    expect(renderCatalogEntryDetail(entry)).toContain('## 用法\n选择一种用法')
    expect(entry.examples).toEqual(['sample one', 'sample two'])
  })
})

describe('buildCommandCatalog: descriptionForAgents', () => {
  it('uses descriptionForAgents over the human description', () => {
    const cmd = makeCmd({
      name: 'comfyui.generate',
      _description: '人类看的描述',
      config: { descriptionForAgents: '当需要画图时调用' },
    })
    const entries = buildCommandCatalog(makeCtx([cmd]))
    expect(entries[0].description).toBe('当需要画图时调用')
  })

  it('falls back to the human description when descriptionForAgents is absent', () => {
    const cmd = makeCmd({ name: 'foo', _description: '普通描述' })
    const entries = buildCommandCatalog(makeCtx([cmd]))
    expect(entries[0].description).toBe('普通描述')
  })
})

describe('buildCommandCatalog: agent-side visibility', () => {
  it('hideForAgents excludes the command from the catalog', () => {
    const cmds = [
      makeCmd({ name: 'a' }),
      makeCmd({ name: 'b', config: { hideForAgents: true } }),
    ]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })

  it('hideForHuman keeps the command visible to agents', () => {
    const cmds = [makeCmd({ name: 'a', config: { hideForHuman: true } })]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })

  it('plain hidden is excluded from the catalog (regression)', () => {
    const cmds = [makeCmd({ name: 'a', config: { hidden: true } })]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries).toHaveLength(0)
  })

  it('hidden + hideForHuman stays visible to agents (projected case)', () => {
    const cmds = [
      makeCmd({ name: 'a', config: { hidden: true, hideForHuman: true } }),
    ]
    const entries = buildCommandCatalog(makeCtx(cmds))
    expect(entries.map((e) => e.name)).toEqual(['a'])
  })
})

describe('renderCatalogEntryDetail: agentHelp', () => {
  it('uses agentHelp for the description section when present', () => {
    const entry: CommandCatalogEntry = {
      name: 'comfyui.generate',
      description: '简短描述',
      agentHelp: '详细技术帮助：template 必填，prompt 必填，loras 传 JSON',
      args: [],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('详细技术帮助')
    expect(out).not.toContain('简短描述')
  })

  it('falls back to description when agentHelp is absent', () => {
    const entry: CommandCatalogEntry = {
      name: 'foo',
      description: '普通描述',
      args: [],
      options: [],
      aliases: [],
      children: [],
    }
    const out = renderCatalogEntryDetail(entry)
    expect(out).toContain('普通描述')
  })
})

describe('projectHideForHuman', () => {
  it('sets hidden=true for a hideForHuman command', () => {
    const config: any = { hideForHuman: true }
    projectHideForHuman(config)
    expect(config.hidden).toBe(true)
  })

  it('does not override an explicitly-set hidden', () => {
    const config: any = { hideForHuman: true, hidden: false }
    projectHideForHuman(config)
    expect(config.hidden).toBe(false)
  })

  it('is a no-op when hideForHuman is absent', () => {
    const config: any = {}
    projectHideForHuman(config)
    expect(config.hidden).toBeUndefined()
  })
})
