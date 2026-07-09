import { Fragment, h } from '@koishijs/core'

import type {
  MinecraftTextComponent,
  MinecraftTextComponentList,
} from './types'

type Style = {
  color?: string
  bold?: boolean
  italic?: boolean
  underlined?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

export function pruneMessage(content: any) {
  const elements = h.parse(String(content ?? ''))
  return h
    .transform(elements, {
      at: ({ id, name }) => `@${name || id}`,
      audio: () => '[音频]',
      card: () => '[卡片]',
      file: () => '[文件]',
      face: () => '[表情]',
      image: () => '[图片]',
      img: () => '[图片]',
      quote: () => '[回复]',
      video: () => '[视频]',
    })
    .join('')
}

export function toMinecraftTextComponents(
  content: Fragment
): MinecraftTextComponentList {
  const elements = h.parse(String(content ?? ''))
  const components: MinecraftTextComponentList = []

  const sameStyle = (a?: Style, b?: Style) => {
    return (
      (a?.color ?? undefined) === (b?.color ?? undefined) &&
      (a?.bold ?? undefined) === (b?.bold ?? undefined) &&
      (a?.italic ?? undefined) === (b?.italic ?? undefined) &&
      (a?.underlined ?? undefined) === (b?.underlined ?? undefined) &&
      (a?.strikethrough ?? undefined) === (b?.strikethrough ?? undefined) &&
      (a?.obfuscated ?? undefined) === (b?.obfuscated ?? undefined)
    )
  }

  const pushText = (text: string, style?: Style) => {
    if (!text) return
    const last = components[components.length - 1]
    if (
      last &&
      typeof last === 'object' &&
      typeof last.text === 'string' &&
      !last.extra &&
      !last.clickEvent &&
      !last.hoverEvent &&
      sameStyle(style, last)
    ) {
      last.text += text
      return
    }
    components.push({ text, ...(style || {}) })
  }

  const flattenText = (nodes: any[]): string => {
    let acc = ''
    for (const n of nodes || []) {
      if (n == null) continue
      if (typeof n === 'string') {
        acc += n
      } else if (typeof n === 'object') {
        if (n.type === 'text') acc += String(n.attrs?.content ?? '')
        else if (Array.isArray(n.children)) acc += flattenText(n.children)
      }
    }
    return acc
  }

  const visit = (node: any, style: Style) => {
    if (node == null) return
    if (typeof node === 'string') {
      pushText(node, style)
      return
    }
    if (typeof node !== 'object') {
      pushText(String(node), style)
      return
    }

    const type = node.type
    const attrs = node.attrs || {}
    const children = Array.isArray(node.children) ? node.children : []

    if (type === 'text') {
      pushText(String(attrs.content ?? ''), style)
      return
    }

    if (type === 'br') {
      pushText('\n', style)
      return
    }

    if (type === 'at') {
      const label = `@${attrs.name || attrs.id || ''}`
      pushText(label, { ...style, color: style.color ?? 'yellow' })
      return
    }

    if (type === 'face') {
      const name = attrs.name || attrs.text || attrs.id
      pushText(name ? `:${name}:` : '[表情]', style)
      return
    }

    if (type === 'quote') {
      // 尽量把引用内容展示出来（MC 无原生引用 UI，只能用文本近似）
      pushText('↩ ', { ...style, color: style.color ?? 'gray' })
      for (const c of children)
        visit(c, { ...style, color: style.color ?? 'gray' })
      pushText('\n', style)
      return
    }

    if (type === 'a') {
      const href = attrs.href || attrs.url
      const label = flattenText(children) || String(href || '')
      const clickEvent = href
        ? {
            action: 'open_url',
            value: String(href),
          }
        : undefined
      const hoverEvent = href
        ? {
            action: 'show_text',
            value: {
              text: String(href),
              color: 'gray',
            } as MinecraftTextComponent,
          }
        : undefined
      components.push({
        text: label,
        color: 'blue',
        underlined: true,
        clickEvent,
        hoverEvent,
      })
      return
    }

    if (
      type === 'image' ||
      type === 'img' ||
      type === 'video' ||
      type === 'audio' ||
      type === 'file'
    ) {
      const url = attrs.src || attrs.url || attrs.href
      const filename = attrs.file || attrs.name || attrs.title
      const label =
        type === 'audio'
          ? '[音频]'
          : type === 'video'
            ? '[视频]'
            : type === 'file'
              ? '[文件]'
              : '[图片]'
      if (url) {
        components.push({
          text: label,
          color: 'blue',
          underlined: true,
          clickEvent: { action: 'open_url', value: String(url) },
          hoverEvent: {
            action: 'show_text',
            value: {
              text: `${label}${filename ? ` ${filename}` : ''}\n${String(url)}`,
              color: 'gray',
            } as MinecraftTextComponent,
          },
        })
      } else {
        pushText(label, style)
      }
      return
    }

    // style wrappers
    if (type === 'b' || type === 'strong') {
      for (const c of children) visit(c, { ...style, bold: true })
      return
    }
    if (type === 'i' || type === 'em') {
      for (const c of children) visit(c, { ...style, italic: true })
      return
    }
    if (type === 'u') {
      for (const c of children) visit(c, { ...style, underlined: true })
      return
    }
    if (type === 's' || type === 'del') {
      for (const c of children) visit(c, { ...style, strikethrough: true })
      return
    }
    if (type === 'code') {
      for (const c of children)
        visit(c, { ...style, color: style.color ?? 'gray' })
      return
    }

    // default: recurse children
    for (const c of children) visit(c, style)
  }

  for (const el of elements) visit(el, {})
  return components.length ? components : [{ text: '' }]
}

export function fromMinecraftTextComponents(raw: unknown): Fragment {
  const wrap = (tag: string, child: any) => h(tag, [child])

  const convert = (v: unknown): Fragment => {
    if (v == null) return ''
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      return String(v)
    }

    if (Array.isArray(v)) {
      return h(
        h.Fragment,
        v.map((x) => convert(x))
      )
    }

    if (typeof v !== 'object') return String(v)

    const obj: any = v
    const textPart = typeof obj.text === 'string' ? obj.text : ''
    const extraPart = obj.extra ? convert(obj.extra) : ''
    let inner: Fragment

    if (textPart && extraPart) inner = h(h.Fragment, [textPart, extraPart])
    else if (textPart) inner = textPart
    else inner = extraPart

    // styles
    if (obj.bold) inner = wrap('b', inner)
    if (obj.italic) inner = wrap('i', inner)
    if (obj.underlined) inner = wrap('u', inner)
    if (obj.strikethrough) inner = wrap('s', inner)

    // link
    const click = obj.clickEvent
    if (
      click &&
      click.action === 'open_url' &&
      typeof click.value === 'string'
    ) {
      inner = h(
        'a',
        { href: click.value },
        Array.isArray(inner) ? inner : [inner]
      )
    }

    return inner
  }

  return convert(raw)
}

export function createSenderSpeakComponents(
  message: MinecraftTextComponent | MinecraftTextComponentList,
  sender?: {
    username: string
    color?: string
    hover?: MinecraftTextComponent | MinecraftTextComponentList
  }
) {
  const msgList: MinecraftTextComponentList = Array.isArray(message)
    ? message
    : [message]

  const hover =
    sender?.hover == null
      ? undefined
      : Array.isArray(sender.hover)
        ? { text: '', extra: sender.hover }
        : sender.hover

  // 用一个根组件包裹 extra，避免后续组件继承到前缀的颜色。
  // 根组件设为 white，则未显式指定 color 的文本默认显示为白色。
  const root: MinecraftTextComponent = {
    text: '',
    color: 'white',
    extra: [
      { text: '[', color: 'white' },
      {
        text: sender?.username ?? '',
        color: sender?.color ?? 'green',
        ...(hover
          ? {
              hoverEvent: {
                action: 'show_text',
                value: hover,
              },
            }
          : {}),
      },
      { text: ']: ', color: 'white' },
      ...msgList,
    ],
  }

  return [root]
}
