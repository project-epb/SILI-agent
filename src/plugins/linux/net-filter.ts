/**
 * Which IPv4 targets the guest may reach. sili-core shares a docker network
 * with an unauthenticated mongo, NapCat and the AI gateway, and the cloud
 * metadata service sits at 100.100.100.200: everything but the public
 * internet is refused. The guest has no IPv6.
 */

const BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT; Aliyun metadata lives here
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12], // docker networks
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking; mihomo fake-ip
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function toInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

const RANGES = BLOCKED_RANGES.map(([base, bits]) => {
  const size = 2 ** (32 - bits)
  const start = toInt(base)!
  return [start, start + size] as const
})

/** True only for a dotted IPv4 address on the public internet. */
export function isPublicIPv4(ip: string): boolean {
  const n = toInt(ip)
  if (n === null) return false
  return !RANGES.some(([start, end]) => n >= start && n < end)
}
