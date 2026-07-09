import { Context, version as KOISHI_VERSION, h } from '@koishijs/core'

import { MONO_FONT } from '@/services/html/fonts'

import BasePlugin from '~/_boilerplate'

import OneBotBot from 'koishi-plugin-adapter-onebot'

import pkgInfo from '../../package.json'

interface OneBotInfo {
  app_name?: string
  app_version?: string
  protocol_version?: string | number
}

interface VersionCardData {
  siliVersion: string
  gitHash: string
  koishiVersion: string
  runtime: string
  platforms: string[]
  onebot?: OneBotInfo | null
  installedPlugins: { name: string; version: string }[]
  activePlugins: string[]
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Render SILI's version info as a dreamy, kawaii info card — soft sky→lavender→
 * sakura palette drawn from her hair, a star motif echoing her hair clips, and
 * pastel category pills. Meant to be screenshotted at its `.frame` element.
 */
function renderVersionCardHtml(d: VersionCardData): string {
  const metaRow = (kind: string, label: string, value: string) =>
    `<div class="row"><span class="k ${kind}">${esc(label)}</span><span class="v">${value}</span></div>`

  const onebotValue = d.onebot
    ? `${esc(d.onebot.app_name ?? 'OneBot')} <b>${esc(d.onebot.app_version ?? '?')}</b> <span class="dim">· protocol ${esc(d.onebot.protocol_version ?? '?')}</span>`
    : null

  const pkgChip = (p: { name: string; version: string }) =>
    `<span class="chip">${esc(p.name)}<em>${esc(p.version)}</em></span>`
  const activeChip = (name: string) =>
    `<span class="chip alt">${esc(name)}</span>`

  const section = (icon: string, title: string, count: number, chips: string) =>
    `<div class="section">
      <div class="title"><span class="ic">${icon}</span>${esc(title)}<span class="count">${count}</span></div>
      <div class="chips">${chips}</div>
    </div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root {
    --card: #ffffff; --ink: #4a4370; --muted: #9b93c4;
    --sky: #5fb0ee; --lav: #a08ff0; --sakura: #f199cc; --star: #ffcf4d;
    --sky-soft: #e3f1fd; --lav-soft: #ece7fe;
    --sakura-soft: #fce2f2; --star-soft: #fff2cf;
    --border: #f0ecfb;
    --sans: "Segoe UI Rounded", "Hiragino Maru Gothic ProN", "Varela Round",
      -apple-system, BlinkMacSystemFont, "Noto Sans SC", "PingFang SC",
      "Microsoft YaHei", system-ui, sans-serif;
    --mono: ${MONO_FONT};
  }
  * { box-sizing: border-box; margin: 0; }
  html, body { padding: 0; }
  body { display: inline-block; font-family: var(--sans); color: var(--ink); }

  .frame {
    position: relative;
    padding: 38px;
    background:
      radial-gradient(58% 55% at 12% 8%, #e6f0ff 0%, transparent 60%),
      radial-gradient(52% 50% at 92% 16%, #fce4f4 0%, transparent 55%),
      radial-gradient(60% 60% at 82% 100%, #efe7ff 0%, transparent 55%),
      linear-gradient(135deg, #eff4ff, #f9effb);
  }

  .card {
    position: relative;
    width: 600px;
    background: var(--card);
    border: 1px solid #ffffff;
    border-radius: 30px;
    overflow: hidden;
    box-shadow:
      0 24px 60px rgba(150, 140, 220, 0.28),
      0 4px 14px rgba(150, 140, 220, 0.12);
  }
  /* hair-dye gradient ribbon along the top edge */
  .card::before {
    content: ""; position: absolute; left: 0; right: 0; top: 0; height: 6px;
    background: linear-gradient(100deg, var(--sky), var(--lav) 50%, var(--sakura));
  }

  /* ── header ── */
  .head {
    position: relative;
    padding: 30px 30px 22px;
    background:
      radial-gradient(120% 130% at 0% 0%, rgba(95, 176, 238, 0.13), transparent 55%),
      radial-gradient(120% 130% at 100% 0%, rgba(241, 153, 204, 0.16), transparent 55%);
  }
  .deco { position: absolute; inset: 0; pointer-events: none; }
  .deco .s { position: absolute; line-height: 1; }
  .deco .s1 { top: 20px; right: 168px; color: var(--star); font-size: 17px; opacity: .9; }
  .deco .s2 { top: 46px; right: 40px; color: var(--sakura); font-size: 12px; opacity: .85; }
  .deco .s3 { bottom: 18px; right: 128px; color: var(--sky); font-size: 11px; opacity: .7; }
  .deco .s4 { top: 30px; right: 118px; color: var(--lav); font-size: 9px; opacity: .7; }

  .brand { display: flex; align-items: center; gap: 11px; }
  .logo {
    font-size: 40px; font-weight: 800; letter-spacing: .5px; line-height: 1;
    background: linear-gradient(100deg, var(--sky), var(--lav) 48%, var(--sakura));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .star-badge { color: var(--star); font-size: 19px; }
  .ver-group { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .ver {
    font-family: var(--mono); font-size: 14px; font-weight: 600;
    color: #6f5fc0; background: var(--lav-soft);
    padding: 5px 13px; border-radius: 999px;
  }
  .commit {
    font-family: var(--mono); font-size: 12px; color: #a99bd0;
    background: #ffffff; border: 1px solid var(--border);
    padding: 4px 10px; border-radius: 999px;
  }
  .sub { margin-top: 11px; font-size: 12.5px; color: var(--muted); }
  .sub .spark { color: var(--sakura); }

  /* ── meta ── */
  .meta { padding: 20px 30px; display: grid; gap: 11px; }
  .row { display: flex; align-items: center; gap: 13px; font-size: 13.5px; }
  .k {
    flex: 0 0 92px; text-align: center; padding: 4px 0; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: .3px;
  }
  .k.koishi { background: var(--lav-soft); color: #6f5fc0; }
  .k.runtime { background: var(--sky-soft); color: #3d84c4; }
  .k.platforms { background: var(--sakura-soft); color: #c85fa0; }
  .k.onebot { background: var(--star-soft); color: #bd8c1a; }
  .v { color: var(--ink); }
  .v b { font-family: var(--mono); font-weight: 600; color: #6f5fc0; }
  .v .dim { color: var(--muted); }
  .mono { font-family: var(--mono); }

  /* ── plugin sections ── */
  .section { padding: 16px 30px 20px; }
  .section + .section { border-top: 1px dashed var(--border); }
  .title {
    display: flex; align-items: center; gap: 9px; margin-bottom: 14px;
    font-size: 12px; font-weight: 800; color: var(--ink);
  }
  .title .ic { color: var(--star); font-size: 13px; }
  .count {
    font-family: var(--mono); font-size: 11px; padding: 2px 10px;
    border-radius: 999px; background: var(--lav-soft); color: #6f5fc0;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; padding: 4px 11px; border-radius: 11px;
    background: linear-gradient(135deg, var(--sky-soft), var(--lav-soft));
    border: 1px solid #ffffff; color: #5a4f9a;
  }
  .chip em {
    font-family: var(--mono); font-style: normal; font-size: 11px; color: #c85fa0;
  }
  .chip.alt {
    background: #ffffff; border: 1px solid var(--sakura-soft); color: var(--muted);
  }
</style>
</head>
<body>
<div class="frame">
  <div class="card">
    <div class="head">
      <div class="deco" aria-hidden="true">
        <span class="s s1">✦</span>
        <span class="s s2">✧</span>
        <span class="s s3">✦</span>
        <span class="s s4">✦</span>
      </div>
      <div class="brand">
        <span class="logo">SILI</span>
        <span class="star-badge">✦</span>
        <span class="ver-group">
          <span class="ver">v${esc(d.siliVersion)}</span>
          <span class="commit">${esc(d.gitHash)}</span>
        </span>
      </div>
      <div class="sub">
        <span class="spark">✧</span> The data transmission network with Spatiotemporal Isomorphic and Limitless Interdimensional
      </div>
    </div>
    <div class="meta">
      ${metaRow('koishi', 'Koishi', `<span class="mono">v${esc(d.koishiVersion)}</span>`)}
      ${metaRow('runtime', 'Runtime', `<span class="mono">${esc(d.runtime)}</span>`)}
      ${metaRow('platforms', 'Platforms', esc(d.platforms.join(' · ') || '—'))}
      ${onebotValue ? metaRow('onebot', 'OneBot', onebotValue) : ''}
    </div>
    ${section(
      '✦',
      'Installed Plugins',
      d.installedPlugins.length,
      d.installedPlugins.map(pkgChip).join('')
    )}
    ${section(
      '✧',
      'Active Plugins',
      d.activePlugins.length,
      d.activePlugins.map(activeChip).join('')
    )}
  </div>
</div>
</body>
</html>`
}

export default class PluginVersion extends BasePlugin {
  static inject = ['html', 'shell']

  constructor(public ctx: Context) {
    super(ctx, {}, 'version')

    ctx.command('version', '查看SILI版本信息').action(async () => {
      // `.git` is mounted read-only into the container (see docker-compose);
      // `safe.directory` sidesteps git's dubious-ownership guard on hosts where
      // the repo isn't owned by the container's root user.
      const gitHash = await ctx.shell
        .exec('git -c safe.directory=/app rev-parse --short HEAD')
        ?.catch(() => ({ output: '' }))
        ?.then((i) => i?.output?.trim() || '-')
      const platforms = Array.from(
        new Set(ctx.root.bots.map((i) => i.platform))
      )
      const activePlugins = Array.from(ctx.registry.entries())
        .filter(([_, scope]) => scope.status === 2) // ACTIVE
        .map(([_, scope]) => scope.name || '(anonymous)')
      const onebotVersionInfo = await (
        ctx.root.bots.find((i) => i.platform === 'onebot') as OneBotBot<Context>
      )?.internal.getVersionInfo()

      const runtime = process.versions.bun
        ? `Bun v${process.versions.bun} (Node ${process.versions.node})`
        : `Node v${process.versions.node}`

      const installedPlugins = Object.keys(pkgInfo.dependencies)
        .filter(
          (i) =>
            i.startsWith('@koishijs/plugin-') || i.startsWith('koishi-plugin-')
        )
        .map((i) => ({
          name: i.replace(/^(@koishijs\/plugin-|koishi-plugin-)/, ''),
          version: (pkgInfo.dependencies as Record<string, string>)[i],
        }))

      const html = renderVersionCardHtml({
        siliVersion: pkgInfo.version,
        gitHash: gitHash || '-',
        koishiVersion: KOISHI_VERSION,
        runtime,
        platforms,
        onebot: onebotVersionInfo,
        installedPlugins,
        activePlugins,
      })
      const img = await ctx.html.rawHtml(html, '.frame', { type: 'png' })
      return img ? h.image(img, 'image/png') : '检查版本时发生未知错误。'
    })
  }
}
