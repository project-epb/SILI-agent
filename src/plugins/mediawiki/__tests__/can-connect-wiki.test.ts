import { describe, expect, it } from 'vitest'

import { canConnectWiki } from '../utils'

describe('canConnectWiki', () => {
  it('SILI 权限达标即可', () => {
    expect(
      canConnectWiki({ authority: 2, isDirect: false, roles: ['member'] }, 2)
    ).toBe(true)
  })

  it('群主和群管理员在群里可以绑定', () => {
    expect(
      canConnectWiki({ authority: 1, isDirect: false, roles: ['admin'] }, 2)
    ).toBe(true)
    expect(
      canConnectWiki({ authority: 1, isDirect: false, roles: ['owner'] }, 2)
    ).toBe(true)
  })

  it('普通群成员不行', () => {
    expect(
      canConnectWiki({ authority: 1, isDirect: false, roles: ['member'] }, 2)
    ).toBe(false)
  })

  it('私聊里群角色不算数', () => {
    expect(
      canConnectWiki({ authority: 1, isDirect: true, roles: ['admin'] }, 2)
    ).toBe(false)
  })
})
