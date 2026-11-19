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

const sili = (file: string) =>
  `https://r2.epb.wiki/artworks/SILI/stickers/${file}.png`

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
}
