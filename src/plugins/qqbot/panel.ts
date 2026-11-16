/**
 * Group slash-command panel: the list QQ shows when a member types "/" in a
 * group. Tapping an entry sends `@SILI /cmd`, which the v5 prefix accepts.
 *
 * QQ caps each application at 20 panels, so the panel is found by its remark
 * and updated in place, never recreated. `version` must go up on every update
 * or clients keep showing the old list. The response lists panels under
 * `records`; reading the wrong key makes every sync create a new panel.
 *
 * DMs have no panel on purpose: DMs are whitelist-only for now.
 */
import { Bot, Context, Universal } from 'koishi'

const PANEL_REMARK = 'sili-group'

/** Keep it short: personal, spammy commands (profile, pixiv…) stay off. */
export const GROUP_PANEL = [
  { name: '/help', desc: '查看指令列表' },
  { name: '/wiki', desc: '查询 wiki 页面' },
  { name: '/whoasked', desc: '谁艾特我？' },
  { name: '/sticker', desc: '生成表情包' },
  { name: '/dice', desc: '掷骰子' },
  { name: '/search', desc: '搜图片' },
]

interface PanelRecord {
  panel_id: string
  panel?: { remark?: string; version?: number }
}

export function setupGroupPanel(ctx: Context) {
  const logger = ctx.logger('qqbot-panel')
  const done = new Set<string>()

  const sync = async (bot: Bot) => {
    if (bot.platform !== 'qq' || bot.status !== Universal.Status.ONLINE) return
    if (done.has(bot.selfId)) return
    done.add(bot.selfId)
    const internal = (bot as any).internal
    try {
      const { records = [] }: { records?: PanelRecord[] } =
        (await internal.getPanels({ scope: 'group' })) ?? {}
      const mine = records.find((p) => p.panel?.remark === PANEL_REMARK)
      const panel = {
        items: GROUP_PANEL.map((i) => ({ ...i, type: 'command' })),
        remark: PANEL_REMARK,
        version: (mine?.panel?.version ?? 0) + 1,
      }
      if (mine) {
        await internal.modifyPanel(mine.panel_id, { scope: 'group', panel })
      } else {
        await internal.createPanel({
          scope: 'group',
          target_type: 'all',
          panel,
        })
      }
      logger.info('group panel synced for %s (v%d)', bot.selfId, panel.version)
    } catch (error) {
      done.delete(bot.selfId)
      logger.warn('sync group panel', error)
    }
  }

  ctx.on('ready', () => ctx.bots.forEach((bot) => void sync(bot)))
  ctx.on('login-added', (session) => void sync(session.bot))
  ctx.on('login-updated', (session) => void sync(session.bot))
}
