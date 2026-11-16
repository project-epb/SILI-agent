import { Binding, Context, Session } from 'koishi'

import BasePlugin from '~/_boilerplate'

export default class PluginAbout extends BasePlugin {
  #masterUid = 1
  #masterName = '机智的小鱼君'
  #masterPidCache: Map<string, string> = new Map()

  constructor(ctx: Context) {
    super(ctx, null, 'about')

    ctx
      .command('about', '自我介绍')
      .alias('自我介绍', '关于')
      .action(async ({ session }) => {
        const masterPid = await this.getMasterPlatformId(session as Session)
        return (
          <>
            <img src="https://r2.epb.wiki/avatar/SILI.jpg" />
            <p>✨ 自我介绍</p>
            <p>
              您好，我的名字是 The data transmission network with Spatiotemporal
              Isomorphic and Limitless Interdimensional
            </p>
            <p>鉴于很少有人能喊对我的全名，我建议您简单称我为 SILI</p>
            <p>
              我目前隶属于万界规划局项目组，直属上司为
              {masterPid ? (
                <at id={masterPid} name={this.#masterName} />
              ) : (
                `@${this.#masterName}`
              )}
              。
            </p>
            <p>⚡ 更多信息</p>
            <p>
              输入“
              <at id={session.selfId} name="SILI" />
              帮助”查看帮助信息
            </p>
            <p>
              ——或者你也可以艾特我后直接输入问题，并以问号结尾，直截了当地提出问题~
            </p>
            <p>
              开源地址(记得点✨哦): https://github.com/project-epb/SILI-agent
            </p>
          </>
        )
      })
  }

  async getMasterPlatformId(session: Session) {
    // QQ openids differ per bot application, so cache per bot.
    const key = `${session.platform}:${session.selfId}`
    if (this.#masterPidCache.has(key)) return this.#masterPidCache.get(key)
    const db = session.app.database
    const bindings = await db
      .get('binding', { aid: this.#masterUid, platform: session.platform })
      .catch(() => [] as Binding[])
    let pid = bindings[0]?.pid ?? ''
    if (bindings.length > 1 && session.platform === 'qq') {
      // Several QQ openids (one per bot app ever bound): use the one this bot has seen.
      const [seen] = await db
        .get('qqbot_user' as any, {
          selfId: session.selfId,
          id: bindings.map((b) => b.pid),
        })
        .catch(() => [] as { id: string }[])
      if (seen) pid = (seen as { id: string }).id
    }
    if (pid) this.#masterPidCache.set(key, pid)
    return pid
  }
}
