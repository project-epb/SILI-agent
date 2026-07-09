/**
 * @name patch-callme
 * @command callme
 * @desc 对 callme 插件的 hack
 * @authority -
 */
import { Context, Time, segment } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

declare module 'koishi' {
  export interface Channel {
    disable: string[]
  }
  export interface User {
    name: string
  }
}

export default class PatchCallme extends BasePlugin {
  static inject = ['mint']

  constructor(ctx: Context) {
    super(ctx, null, 'callme')

    ctx
      .command('callme', '', { minInterval: Time.hour, maxUsage: 5 })
      .channelFields(['disable'])
      .userFields(['name', 'id'])
      .check(({ session, options }, name) => {
        if (
          session!.channel?.disable?.includes('callme') ||
          (options as any).help
        ) {
          return
        }
        if (!name) {
          const escapedName = segment.escape(session?.user?.name || '')
          return session!.user?.name ? (
            <random>
              <template>SILI认得你，{escapedName}，你好~</template>
              <template>啊，这不是{escapedName}吗~</template>
            </random>
          ) : (
            <random>
              <template>SILI还不认得你哟~</template>
              <template>你还没告诉SILI你叫什么呢~</template>
              <template>你还没有向SILI自我介绍过哟~</template>
            </random>
          )
        }
      })
      // 检查不合法词汇
      .check((_, name) => {
        if (!name) return
        const invalid = /[<>\x00-\x1F\x7F]/.test(name)
        if (invalid) {
          return (
            <>
              果咩，
              <random>
                <template>这个名字SILI不会念！</template>
                <template>这个名字太奇怪了！</template>
                <template>这个名字实在是太为难SILI了！</template>
              </random>
            </>
          )
        }
      })
      // 检查违禁词
      .check((_, name) => {
        if (!name) return
        const verify = ctx.mint.verify(name)
        if (/(sili)/gi.test(name) || !verify) {
          return (
            <>
              哒咩，
              <random>
                <template>SILI不喜欢这个名字！</template>
                <template>这样是不对的，请不要拿SILI开玩笑！</template>
                <template>SILI觉得这个名字很冒犯！</template>
              </random>
            </>
          )
        }
      })
      // 检查是否重名
      .check(async ({ session }, name) => {
        if (!name) return
        if (session.user.name === name) return
        const [existUser] = await session.app.database.get(
          'user',
          { name, id: { $not: session.user.id } },
          { limit: 1 }
        )
        if (existUser) {
          return (
            <>
              <random>
                <template>这个名字已经被占用了哟~</template>
                <template>这个名字已经有人用过了~</template>
              </random>
            </>
          )
        }
      })

    ctx
      .command('admin.reset-name', '重置用户名字', { authority: 4 })
      .option('user', '-u <user:user> 目标用户', {})
      .action(async ({ command, session, options }) => {
        let [platform, uid] = options.user?.split(':') || []
        if (!uid && platform) {
          uid = platform
          platform = session.platform
        }
        if (!uid) {
          return session.execute({
            name: command.name,
            options: { help: true },
          })
        }
        const user = await session.app.database.getUser(platform, uid)
        if (!user) {
          return '没有找到这个用户'
        }
        await session.app.database.setUser(platform, uid, {
          name: null,
        })
        return '重置成功'
      })
  }
}
