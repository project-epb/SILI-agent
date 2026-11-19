/**
 * Each persona's own sticker set: first-class, sent by name, listed in the
 * system prompt. They never enter the sticker pool table — no vision tagging,
 * no random picks. Files live on the CDN under `artworks/<Persona>/stickers/`.
 */
export interface PersonaSticker {
  name: string
  /** What it says, as the persona prompt shows it. */
  meaning: string
  url: string
}

/**
 * The 512px originals render too large in QQ, so they go out through
 * Cloudflare image resizing (enabled on r2.epb.wiki), keeping PNG + alpha.
 */
const sized = (path: string) =>
  `https://r2.epb.wiki/cdn-cgi/image/width=200,format=png/${path}`

const sili = (file: string) => sized(`artworks/SILI/stickers/${file}.png`)
const noir = (file: string) => sized(`artworks/noir/stickers/${file}.png`)

export const PERSONA_STICKERS: Record<string, PersonaSticker[]> = {
  sili: [
    { name: '打招呼', meaning: '打招呼、问好、冒泡', url: sili('hello') },
    { name: '好耶', meaning: '好耶、开心庆祝', url: sili('yay') },
    { name: '比心', meaning: '比心、喜欢、示好', url: sili('heart') },
    { name: '点赞', meaning: '点赞、好的、没问题', url: sili('thumbsup') },
    { name: '疑惑', meaning: '疑惑、没看懂', url: sili('confused') },
    { name: '震惊', meaning: '震惊、不敢相信', url: sili('shocked') },
    { name: '哭哭', meaning: '哭哭、委屈、难过', url: sili('cry') },
    { name: '生气', meaning: '生气、哼（多半是玩笑）', url: sili('angry') },
    { name: '无语', meaning: '无语、流汗、尴尬', url: sili('speechless') },
    { name: '害羞', meaning: '害羞、不好意思、被夸了', url: sili('shy') },
    { name: '思考', meaning: '思考、让我想想', url: sili('thinking') },
    { name: '谢谢', meaning: '谢谢、感谢', url: sili('thanks') },
    { name: '加油', meaning: '加油、打气', url: sili('cheer') },
    { name: '吃瓜', meaning: '吃瓜、围观、看戏', url: sili('popcorn') },
    { name: '摸鱼躺平', meaning: '摸鱼、躺平、摆烂', url: sili('slacking') },
    { name: '晚安', meaning: '晚安、困了、去睡了', url: sili('goodnight') },
  ],
  noir: [
    { name: '打招呼', meaning: '懒洋洋地打招呼', url: noir('hello') },
    { name: '嘲笑', meaning: '捂嘴坏笑、嘲讽对方', url: noir('smug') },
    { name: '比心', meaning: '别过脸比心，傲娇示好', url: noir('heart') },
    { name: '点赞', meaning: '敷衍地点个赞、行吧', url: noir('thumbsup') },
    { name: '疑惑', meaning: '挑眉：哈？你在说什么', url: noir('confused') },
    { name: '震惊', meaning: '震惊、不敢相信', url: noir('shocked') },
    { name: '假哭', meaning: '假哭卖惨，其实在偷笑', url: noir('fakecry') },
    { name: '生气', meaning: '跺脚生气（多半是装的）', url: noir('angry') },
    { name: '嫌弃', meaning: '嫌弃、恶心、离我远点', url: noir('disgust') },
    { name: '嘴硬害羞', meaning: '被戳中了还嘴硬', url: noir('shy') },
    { name: '坏主意', meaning: '憋坏水、有坏主意了', url: noir('scheme') },
    { name: '勉强道谢', meaning: '不情不愿地说谢谢', url: noir('thanks') },
    { name: '加油', meaning: '加油、包在我身上', url: noir('cheer') },
    { name: '吃瓜', meaning: '吃瓜看戏、幸灾乐祸', url: noir('popcorn') },
    { name: '摸鱼躺平', meaning: '摸鱼、躺平、无聊', url: noir('slacking') },
    { name: '晚安', meaning: '晚安、困了、去睡了', url: noir('goodnight') },
  ],
}
