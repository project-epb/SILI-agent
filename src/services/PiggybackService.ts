import { Argv, Context, Service, Session } from '@koishijs/core'

declare module 'koishi' {
  interface Context {
    piggyback: PiggybackService
  }
  interface Session {
    executeAsUser(userId: string, content: Argv | string): Promise<any>
  }
}

export default class PiggybackService extends Service {
  static readonly inject = ['database']

  constructor(public ctx: Context) {
    super(ctx, 'piggyback')
    const that = this
    ctx.set(
      'session.executeAsUser',
      function (this: Session, userId: string, content: any) {
        return that.executeAsUser(this, userId, content)
      }
    )
  }

  async executeAsUser(
    session: Session,
    userId: string,
    content: Argv | string
  ) {
    const mockSess = session.bot.session(session.event)
    // mockSess[Session.shadow] = session
    mockSess.userId = userId
    mockSess.user = await mockSess.observeUser(['authority'])
    Object.assign(
      mockSess.author,
      await this.ctx.database
        .getUser(mockSess.platform, mockSess.userId)
        .catch(() => ({}))
    )
    mockSess.send = session.send
    const result = await mockSess.execute(content as any)
    await Promise.all([
      mockSess.user?.$update(),
      mockSess.channel?.$update(),
      mockSess.guild?.$update(),
    ])
    return result
  }
}
