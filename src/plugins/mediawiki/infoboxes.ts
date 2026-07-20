import { InfoboxDefinition } from './types/Infobox'

export const INFOBOX_DEFINITION: InfoboxDefinition[] = [
  // 萌娘百科
  {
    match: (url) => url.host.endsWith('moegirl.org.cn'),
    selector: [
      // 标准信息框
      '.mw-parser-output .infotemplatebox',
      '.mw-parser-output table.infobox',
      '.mw-parser-output .infobox2',
      '.mw-parser-output .infobox3',
      '.mw-parser-output .moe-infobox',
      // 成句
      '.mw-parser-output table.infoboxSpecial',
    ],
    injectStyles: '',
    skin: 'apioutput',
    // 未设头像的用户 404 会自动重定向到 default.png，因此永远有图
    getAvatarUrl: ({ userid }) =>
      `https://storage.moegirl.org.cn/moegirl/avatars/${userid}/latest.png`,
  },
  // Minecraft Wiki
  {
    match: (url) => url.host === 'minecraft.fandom.com',
    selector: ['.mw-parser-output .notaninfobox'],
    skin: 'apioutput',
  },
  // Fandom (basic)
  {
    match: (url) => url.host.endsWith('fandom.com'),
    selector: ['.mw-parser-output aside.portable-infobox'],
    skin: 'apioutput',
  },
  // 万界规划局
  {
    match: (url) => url.host.endsWith('wjghj.cn'),
    selector: ['.mw-parser-output .portable-infobox:not(.pi-theme-顶部提示小)'],
    skin: 'apioutput',
  },
  // 最终幻想XIV中文维基
  {
    match: (url) => url.host === 'ff14.huijiwiki.com',
    selector: [
      // 道具
      '.mw-parser-output .infobox-item',
      // 任务
      '.mw-parser-output .quest-frame',
      // 副本
      '.mw-parser-output .instance-infobox',
      // 常规
      '.mw-parser-output .ff14-infobox',
    ],
    // 灰机头像统一域；未设头像会真 404，模板 onerror 回退占位。timestamp 仅防缓存，出图无需
    getAvatarUrl: ({ userid }) =>
      `https://av.huijiwiki.com/my_wiki_${userid}_m.png`,
  },
]
