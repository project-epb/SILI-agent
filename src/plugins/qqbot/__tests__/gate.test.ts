import { describe, expect, it } from 'vitest'

import {
  type GateRules,
  type ServedLookup,
  type SessionFacts,
  autoAssignFor,
  autoAuthorizeFor,
  decideGate,
  extractCommandName,
  isServed,
} from '../gate'

const rules: GateRules = {
  groupCommands: new Set(['assign', 'group-migrate']),
  dmCommands: new Set(['bind', '多账号绑定']),
  bindTokenPrefix: 'koishi/',
}

function lookup(opts: { groups?: string[]; dms?: string[] } = {}): ServedLookup {
  const groups = new Set(opts.groups ?? [])
  const dms = new Set(opts.dms ?? [])
  return {
    isGroupActive: (_p, _s, channelId) => groups.has(channelId),
    isDmAllowed: (_p, _s, userId) => dms.has(userId),
  }
}

const group = (platform = 'qq', channelId = 'G1'): SessionFacts => ({
  platform,
  isDirect: false,
  selfId: 'BOT',
  channelId,
  userId: 'U1',
})
const dm = (platform = 'qq', userId = 'U1'): SessionFacts => ({
  platform,
  isDirect: true,
  selfId: 'BOT',
  channelId: `private:${userId}`,
  userId,
})

describe('isServed', () => {
  it('never serves OneBot, even if its group looks assigned', () => {
    expect(isServed(group('onebot', 'G1'), lookup({ groups: ['G1'] }))).toBe(false)
  })
  it('serves unguarded platforms unconditionally', () => {
    expect(isServed(group('discord'), lookup())).toBe(true)
    expect(isServed(dm('dingtalk'), lookup())).toBe(true)
  })
  it('serves a qq group only when activated', () => {
    expect(isServed(group('qq', 'G1'), lookup())).toBe(false)
    expect(isServed(group('qq', 'G1'), lookup({ groups: ['G1'] }))).toBe(true)
  })
  it('guards qqguild channels like qq groups', () => {
    expect(isServed(group('qqguild', 'C1'), lookup())).toBe(false)
  })
  it('serves a qq DM only when allowed', () => {
    expect(isServed(dm('qq', 'U1'), lookup())).toBe(false)
    expect(isServed(dm('qq', 'U1'), lookup({ dms: ['U1'] }))).toBe(true)
  })
})

describe('decideGate', () => {
  it('drops plain messages in unactivated groups', () => {
    expect(decideGate(group(), 'hello', 'hello', lookup(), rules)).toBe('drop')
  })
  it('lets whitelisted commands through in unactivated groups', () => {
    expect(decideGate(group(), 'assign', 'assign', lookup(), rules)).toBe('pass')
    expect(decideGate(group(), 'group-migrate 123', 'group-migrate', lookup(), rules)).toBe('pass')
  })
  it('does not accept DM-only commands in groups', () => {
    expect(decideGate(group(), 'bind', 'bind', lookup(), rules)).toBe('drop')
  })
  it('passes everything in activated groups', () => {
    expect(decideGate(group(), 'hello', 'hello', lookup({ groups: ['G1'] }), rules)).toBe('pass')
  })
  it('drops stranger DMs except bind and its alias', () => {
    expect(decideGate(dm(), 'hi', 'hi', lookup(), rules)).toBe('drop')
    expect(decideGate(dm(), 'bind', 'bind', lookup(), rules)).toBe('pass')
    expect(decideGate(dm(), '多账号绑定', '多账号绑定', lookup(), rules)).toBe('pass')
    expect(decideGate(dm(), 'assign', 'assign', lookup(), rules)).toBe('drop')
  })
  it('passes OneBot only for bind codes', () => {
    expect(decideGate(group('onebot'), 'koishi/abc123', null, lookup(), rules)).toBe('pass')
    expect(decideGate(group('onebot'), '  koishi/abc123', null, lookup(), rules)).toBe('pass')
    expect(decideGate(group('onebot'), '[[维基]]', null, lookup(), rules)).toBe('drop')
    expect(decideGate(group('onebot'), 'bind', 'bind', lookup({ groups: ['G1'] }), rules)).toBe('drop')
  })
  it('leaves other platforms alone', () => {
    expect(decideGate(group('discord'), 'anything', null, lookup(), rules)).toBe('pass')
  })
})

describe('extractCommandName', () => {
  it('takes the first word and lowercases it', () => {
    expect(extractCommandName('Assign -r', [])).toBe('assign')
  })
  it('strips one prefix, preferring the longest', () => {
    expect(extractCommandName('/assign', ['/'])).toBe('assign')
    expect(extractCommandName('!! help', ['!', '!!'])).toBe('help')
  })
  it('returns null for empty content', () => {
    expect(extractCommandName('   ', ['/'])).toBeNull()
  })
})

describe('autoAuthorizeFor / autoAssignFor', () => {
  it('never creates users for OneBot or unserved guarded sessions', () => {
    expect(autoAuthorizeFor(group('onebot'), null, lookup(), rules)).toBe(0)
    expect(autoAuthorizeFor(group('qq'), 'hello', lookup(), rules)).toBe(0)
    expect(autoAuthorizeFor(dm('qq'), 'hi', lookup(), rules)).toBe(0)
  })
  it('creates the user for a stranger DM running bind (plugin-bind needs the row)', () => {
    expect(autoAuthorizeFor(dm('qq'), 'bind', lookup(), rules)).toBe(1)
  })
  it('creates users normally when served or on unguarded platforms', () => {
    expect(autoAuthorizeFor(group('qq'), 'x', lookup({ groups: ['G1'] }), rules)).toBe(1)
    expect(autoAuthorizeFor(group('discord'), null, lookup(), rules)).toBe(1)
  })
  it('auto-assigns only on unguarded platforms', () => {
    expect(autoAssignFor('qq')).toBe(false)
    expect(autoAssignFor('qqguild')).toBe(false)
    expect(autoAssignFor('onebot')).toBe(false)
    expect(autoAssignFor('discord')).toBe(true)
  })
})
