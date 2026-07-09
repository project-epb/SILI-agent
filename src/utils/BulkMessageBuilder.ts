import { Session, Universal, h } from '@koishijs/core'

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
    return this.#figure
  }
  get figure() {
    return this.#figure
  }

  addLine(author: MsgUser, message: string) {
    this.#figure.children.push(h('message', author, message))
    return this
  }
  botSay(msg: string) {
    this.addLine(this.#bot, msg)
    return this
  }
  authorSay(msg: string) {
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
