import { Context, Logger, snakeCase } from '@koishijs/core'

export default class BasePlugin<T = any> {
  #name: string
  readonly config: T

  constructor(
    public ctx: Context,
    config: T = undefined,
    name = 'plugin'
  ) {
    this.name = name
    this.config = config || ({} as T)
  }

  set name(name: string) {
    this.#name = snakeCase(name).toUpperCase()
  }
  get name() {
    return this.#name
  }

  get logger(): Logger {
    return this.ctx.logger(this.name)
  }
}
