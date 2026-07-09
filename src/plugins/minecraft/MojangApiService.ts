/**
 * @link https://zh.minecraft.wiki/w/Mojang_API
 */
import { Context, Service } from '@koishijs/core'

import { Fexios } from 'fexios'

declare module 'koishi' {
  interface Context {
    mojang: MojangApiService
  }
}

export class MojangApiService extends Service {
  private readonly request = new Fexios({
    baseURL: 'https://api.mojang.com',
  })

  constructor(ctx: Context) {
    super(ctx, 'mojang', true)
  }

  isValidUuid(uuid: string) {
    return /^[0-9a-f-A-F-]{32,36}$/.test(uuid)
  }
  async gerUuidByName(name: string) {
    return this.request
      .get<{
        id: string
        name: string
      }>(`/users/profiles/minecraft/${name}`)
      .then(({ data }) => data)
  }
  async getUuidsByNames(names: string[]) {
    return this.request
      .post<
        {
          id: string
          name: string
        }[]
      >('/profiles/minecraft', names)
      .then(({ data }) => data)
  }
}
