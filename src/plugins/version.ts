import { Context, version as KOISHI_VERSION, h } from 'koishi'

import BasePlugin from '~/_boilerplate'

import OneBotBot from 'koishi-plugin-adapter-onebot'

import pkgInfo from '../../package.json'

export default class PluginVersion extends BasePlugin {
  static inject = ['html', 'shell']

  constructor(public ctx: Context) {
    super(ctx, {}, 'version')

    ctx
      .command('version', '查看SILI版本信息')
      .option('all', '-a', { authority: 2 })
      .action(async ({ options }) => {
        const gitHash = await ctx.shell
          .exec('git rev-parse --short HEAD')
          ?.catch(() => ({ output: '' }))
          ?.then((i) => i?.output?.trim() || '-')
        const platforms = Array.from(
          new Set(ctx.root.bots.map((i) => i.platform))
        )
        const activePlugins = Array.from(ctx.registry.entries())
          .filter(
            ([_, scope]) => scope.status === 2 // ACTIVE
          )
          .map(([_, scope]) => scope.name || '(anonymous)')
        const onebotVersionInfo = await (
          ctx.root.bots.find(
            (i) => i.platform === 'onebot'
          ) as OneBotBot<Context>
        )?.internal.getVersionInfo()

        console.info({
          gitHash,
          platforms,
          activePlugins,
          onebotVersionInfo,
        })

        const runtime = process.versions.bun
          ? `Bun v${process.versions.bun} (Node ${process.versions.node})`
          : `Node v${process.versions.node}`

        if (!options!.all) {
          return [
            `[SILI Core] v${pkgInfo.version} (${gitHash?.trim()})`,
            `[Koishi.js] v${KOISHI_VERSION}`,
            `[Runtime] ${runtime}`,
            `[Platforms] ${platforms}`,
            onebotVersionInfo
              ? `[OneBot] ${onebotVersionInfo.app_name} ${onebotVersionInfo.app_version} / protocol ${onebotVersionInfo.protocol_version}`
              : null,
          ]
            .filter(Boolean)
            .join('\n')
        }

        const plugins = Object.keys(pkgInfo.dependencies)
          .filter(
            (i) =>
              i.startsWith('@koishijs/plugin-') ||
              i.startsWith('koishi-plugin-')
          )
          .map(
            (i) =>
              `${i.replace(/^(@koishijs\/|koishi-)/, '')}: ${
                pkgInfo.dependencies[i]
              }`
          )

        const img = await ctx.html.hljs(
          [
            `[SILI Core] v${pkgInfo.version} (${gitHash})`,
            `[Koishi.js] v${KOISHI_VERSION}`,
            `[Runtime] ${runtime}`,
            `- installed plugins:`,
            `  - ${plugins.join('\n  - ')}`,
            `- active plugins:`,
            `  - ${activePlugins.join('\n  - ')}`,
            `[Platforms] ${platforms}`,
            onebotVersionInfo
              ? `[OneBot] ${JSON.stringify(onebotVersionInfo, null, 2)}`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
          'markdown'
        )
        return img ? h.image(img, 'image/jpeg') : '检查版本时发生未知错误。'
      })
  }
}
