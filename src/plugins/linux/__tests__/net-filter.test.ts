import { describe, expect, it } from 'vitest'

import { isPublicIPv4 } from '../net-filter'

describe('isPublicIPv4', () => {
  it('refuses the addresses sili-core can reach privately', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.2.2',
      '172.18.0.3',
      '172.31.255.255',
      '192.168.1.1',
      '100.100.100.200',
      '169.254.169.254',
      '198.18.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ])
      expect(isPublicIPv4(ip), ip).toBe(false)
  })

  it('allows public addresses, including those next to private ranges', () => {
    for (const ip of ['1.1.1.1', '172.15.255.255', '172.32.0.1', '100.128.0.1', '8.8.8.8'])
      expect(isPublicIPv4(ip), ip).toBe(true)
  })

  it('refuses anything that is not a dotted IPv4 address', () => {
    for (const ip of ['localhost', 'sili-mongo', '::1', '1.2.3', '1.2.3.256', '01.2.3.4x'])
      expect(isPublicIPv4(ip), ip).toBe(false)
  })
})
