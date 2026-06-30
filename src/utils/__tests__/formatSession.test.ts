import { describe, it, expect } from 'vitest'

import { getUserRoles, checkUserHasRole } from '../formatSession'

describe('getUserRoles', () => {
  it('包装旧 satori 的 string[] 为 [{ id }]', () => {
    const session = { author: { roles: ['admin', 'member'] } }
    expect(getUserRoles(session)).toEqual([{ id: 'admin' }, { id: 'member' }])
  })

  it('透传新 satori 的 GuildRole[] 对象', () => {
    const session = { author: { roles: [{ id: 'admin', name: '管理员' }] } }
    expect(getUserRoles(session)).toEqual([{ id: 'admin', name: '管理员' }])
  })

  it('roles 缺失返回 []', () => {
    expect(getUserRoles({ author: {} })).toEqual([])
    expect(getUserRoles({})).toEqual([])
    expect(getUserRoles(undefined)).toEqual([])
  })

  it('非数组 roles 返回 []', () => {
    expect(getUserRoles({ author: { roles: 'admin' } })).toEqual([])
  })

  it('回退到 member.roles 与 event.member.roles', () => {
    expect(getUserRoles({ member: { roles: ['x'] } })).toEqual([{ id: 'x' }])
    expect(getUserRoles({ event: { member: { roles: ['y'] } } })).toEqual([
      { id: 'y' },
    ])
  })

  it('author 优先于 member / event', () => {
    const session = {
      author: { roles: ['a'] },
      member: { roles: ['b'] },
      event: { member: { roles: ['c'] } },
    }
    expect(getUserRoles(session)).toEqual([{ id: 'a' }])
  })

  it('过滤掉 null / 无 id / 空 id 的脏元素', () => {
    const session = {
      author: { roles: ['ok', null, { name: 'noId' }, { id: '' }] },
    }
    expect(getUserRoles(session)).toEqual([{ id: 'ok' }])
  })
})

describe('checkUserHasRole', () => {
  it('按 id 命中（string[] 形态）', () => {
    expect(checkUserHasRole({ author: { roles: ['admin'] } }, 'admin')).toBe(
      true
    )
    expect(checkUserHasRole({ author: { roles: ['member'] } }, 'admin')).toBe(
      false
    )
  })

  it('按 id 命中（GuildRole[] 形态）', () => {
    const session = { author: { roles: [{ id: 'admin', name: '管理员' }] } }
    expect(checkUserHasRole(session, 'admin')).toBe(true)
  })

  it('按 name 命中', () => {
    const session = { author: { roles: [{ id: '10086', name: '群主' }] } }
    expect(checkUserHasRole(session, '群主')).toBe(true)
  })

  it('数组入参命中任一即真', () => {
    const session = { author: { roles: ['member'] } }
    expect(checkUserHasRole(session, ['admin', 'member'])).toBe(true)
    expect(checkUserHasRole(session, ['admin', 'owner'])).toBe(false)
  })

  it('大小写敏感', () => {
    expect(checkUserHasRole({ author: { roles: ['admin'] } }, 'Admin')).toBe(
      false
    )
  })

  it('无角色返回 false', () => {
    expect(checkUserHasRole({}, 'admin')).toBe(false)
  })
})
