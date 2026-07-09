import { Context, Service } from '@koishijs/core'

import { Fexios } from 'fexios'

declare module 'koishi' {
  interface Context {
    minecraft_skin: MinecraftSkinService
  }
}

export interface MinecraftSkinModifiers {
  size?: number
  scale?: number
  overlay?: boolean
  default?: 'MHF_Steve' | 'MHF_Alex'
}

export class MinecraftSkinService extends Service {
  private readonly request = new Fexios({
    baseURL: 'https://crafatar.com/',
  })

  constructor(ctx: Context) {
    super(ctx, 'minecraft_skin', true)
  }

  assetUrl(
    type: 'avatar' | 'body' | 'head' | 'skins' | 'capes',
    uuid: string,
    modifiers: MinecraftSkinModifiers = {}
  ) {
    const url = new URL('https://crafatar.com/')
    switch (type) {
      case 'avatar':
        url.pathname = `/avatars/${uuid}`
        break
      case 'body':
        url.pathname = `/renders/body/${uuid}`
        break
      case 'head':
        url.pathname = `/renders/head/${uuid}`
        break
      case 'skins':
        url.pathname = `/skins/${uuid}`
        break
      case 'capes':
        url.pathname = `/capes/${uuid}`
        break
      default:
        throw new Error(`Unknown MinecraftSkin type: ${type}`)
    }
    url.searchParams.set('size', modifiers.size?.toString() ?? '128')
    url.searchParams.set('scale', modifiers.scale?.toString() ?? '10')
    !!modifiers.overlay && url.searchParams.set('overlay', 'true')
    !!modifiers.default && url.searchParams.set('default', modifiers.default)
    return url.href
  }

  async avatar(
    uuid: string,
    modifiers: Pick<MinecraftSkinModifiers, 'size' | 'overlay' | 'default'> = {}
  ) {
    return this.request
      .get<Blob>(`/avatars/${uuid}`, { responseType: 'blob', query: modifiers })
      .then(({ data }) => data)
  }

  async body(
    uuid: string,
    modifiers: Pick<
      MinecraftSkinModifiers,
      'scale' | 'overlay' | 'default'
    > = {}
  ) {
    return this.request
      .get<Blob>(`/renders/body/${uuid}`, {
        responseType: 'blob',
        query: modifiers,
      })
      .then(({ data }) => data)
  }

  async head(
    uuid: string,
    modifiers: Pick<
      MinecraftSkinModifiers,
      'scale' | 'overlay' | 'default'
    > = {}
  ) {
    return this.request
      .get<Blob>(`/renders/head/${uuid}`, {
        responseType: 'blob',
        query: modifiers,
      })
      .then(({ data }) => data)
  }

  async skins(
    uuid: string,
    modifiers: Pick<MinecraftSkinModifiers, 'default'> = {}
  ) {
    return this.request
      .get<Blob>(`/skins/${uuid}`, { responseType: 'blob', query: modifiers })
      .then(({ data }) => data)
  }

  async capes(
    uuid: string,
    modifiers: Pick<MinecraftSkinModifiers, 'default'> = {}
  ) {
    return this.request
      .get<Blob>(`/capes/${uuid}`, { responseType: 'blob', query: modifiers })
      .then(({ data }) => data)
  }
}
