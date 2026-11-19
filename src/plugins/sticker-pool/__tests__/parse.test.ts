import { describe, expect, it } from 'vitest'

import { faceNameFromExt, rewriteInbound, scanImages, sha1FromQQImageUrl } from '../parse'

// Real prod message; the SHA1 was checked against the downloaded original.
const SHA1 = 'd2821fd9ac4b604b1c2a611738fffe986e3a9f92'
const IMG =
  '<img src="https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=EhTSgh_ZrEtgSxwqYRc4__6Ybjqfkhjz_QEg_woo9JadrNyTmAMyBHByb2RQgL2jAVoQWYN5dBekwdQ4ciQ_mCleb3oCgJmCAQJneg&amp;rkey=CAISMGtlA4zfgzJWAHxAsiCHdMkYixu5BNUok8EqEPmkumqTFjGJFJrD_1J7qZOkTaJjdw&amp;spec=0"/>'
const STICKER_MARK = '&lt;faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0="&gt;'
const FACE = '&lt;faceType=1,faceId="489",ext="eyJ0ZXh0Ijoi55+l6K+G5aKe5YqgIn0="&gt;'

describe('sha1FromQQImageUrl', () => {
  it('reads the SHA1 embedded in fileid', () => {
    expect(sha1FromQQImageUrl(IMG.match(/src="([^"]+)"/)![1])).toBe(SHA1)
  })
  it('returns undefined for urls without a fileid', () => {
    expect(sha1FromQQImageUrl('https://example.com/a.png')).toBeUndefined()
  })
})

describe('scanImages', () => {
  it('flags images sent as stickers', () => {
    const [img] = scanImages(`看这个${STICKER_MARK}${IMG}`)
    expect(img).toMatchObject({ sha1: SHA1, stickerFlag: true })
  })
  it('does not flag plain images', () => {
    expect(scanImages(IMG)[0].stickerFlag).toBe(false)
  })
})

describe('faceNameFromExt', () => {
  it('decodes the face name', () => {
    expect(faceNameFromExt('eyJ0ZXh0Ijoi55+l6K+G5aKe5YqgIn0=')).toBe('知识增加')
  })
})

describe('rewriteInbound', () => {
  const known = { id: 7, desc: '漫画疤脸女举手机', usage: '' }
  const lookup = (sha1: string) => (sha1 === SHA1 ? known : undefined)

  it('replaces a known sticker with its placeholder', () => {
    expect(rewriteInbound(`哈${STICKER_MARK}${IMG}`, lookup)).toBe('哈[表情包 id="7" alt="漫画疤脸女举手机"]')
  })
  it('carries the usage note when present', () => {
    const out = rewriteInbound(IMG, () => ({ ...known, usage: '真敢说啊' }))
    expect(out).toBe('[表情包 id="7" alt="漫画疤脸女举手机" 用法="真敢说啊"]')
  })
  it('marks an unknown sticker without exposing the url', () => {
    expect(rewriteInbound(`${STICKER_MARK}${IMG}`, () => undefined)).toBe('[表情包]')
  })
  it('keeps unknown plain images', () => {
    expect(rewriteInbound(IMG, () => undefined)).toBe(IMG)
  })
  it('names QQ faces', () => {
    expect(rewriteInbound(`草${FACE}`, lookup)).toBe('草[QQ表情:知识增加]')
  })
})
