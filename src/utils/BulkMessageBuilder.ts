import { Session, Universal, h } from 'koishi'

type MsgUser = Omit<Universal.User & Universal.GuildMember, 'id'>

export class BulkMessageBuilder {
  #figure = h('message', { forward: '' })
  #bot: MsgUser
  #author: MsgUser
  #content: string
  #isPrependOriginal = false
  constructor(public session: Session) {
    this.#content = session.content
    this.#bot = {
      userId: this.session.bot.userId,
      nickname: this.session.bot.user.name || 'BOT',
    }
    this.#author = {
      userId: session.userId,
      nickname: session.username,
    }
  }

  all() {
    if (this.session.platform === 'onebot') return this.#figure

    const lines = this.#figure.children
      .slice(this.#isPrependOriginal ? 1 : 0)
      .filter(({ children }) => children.length)
    if (!lines.length) return []

    const reply =
      this.#isPrependOriginal && this.session.messageId
        ? [h.quote(this.session.messageId)]
        : []
    for (const [index, line] of lines.entries()) {
      if (index) reply.push(h.text('\n\n'))
      reply.push(...line.children)
    }
    return reply
  }
  get figure() {
    return this.#figure
  }

  addLine(author: MsgUser, message: h.Fragment | null | undefined) {
    this.#figure.children.push(h('message', author, message))
    return this
  }
  botSay(msg: h.Fragment | null | undefined) {
    this.addLine(this.#bot, msg)
    return this
  }
  authorSay(msg: h.Fragment | null | undefined) {
    this.addLine(this.#author, msg)
    return this
  }
  prependOriginal() {
    if (this.#isPrependOriginal) return this
    this.#isPrependOriginal = true
    this.#figure.children.unshift(h('message', this.#author, this.#content))
    return this
  }
}
