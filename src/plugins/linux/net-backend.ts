import dns from 'node:dns/promises'
import net from 'node:net'

import type { NetBackend, NetConnection, NetConnectionEvents } from 'unkernel/node'

import { isPublicIPv4 } from './net-filter'

export interface ProxyAddress {
  host: string
  port: number
}

const CONNECT_TIMEOUT_MS = 20_000
const MAX_PROXY_HEADER_BYTES = 16 * 1024

function notFound(name: string) {
  return Object.assign(new Error(`${name}: not found`), { code: 'ENOTFOUND' })
}

/**
 * The guest's TCP and DNS, limited to the public internet (see net-filter).
 * Lookups drop private answers; connections to anything else are refused.
 * With `proxy`, every connection goes out through its HTTP CONNECT, as all
 * of sili-core's egress does.
 */
export function filteredBackend(proxy?: ProxyAddress): NetBackend {
  const sockets = new Set<net.Socket>()
  return {
    async lookup(name) {
      const answers = await dns.lookup(name, { all: true, family: 4 }).catch(() => {
        throw notFound(name)
      })
      const allowed = answers.map((a) => a.address).filter(isPublicIPv4)
      if (!allowed.length) throw notFound(name)
      return allowed
    },
    connect({ host, port }, ev) {
      return openConnection(host, port, ev, sockets, proxy)
    },
    close() {
      for (const s of sockets) s.destroy()
      sockets.clear()
    },
  }
}

function openConnection(
  host: string,
  port: number,
  ev: NetConnectionEvents,
  sockets: Set<net.Socket>,
  proxy: ProxyAddress | undefined
): NetConnection {
  let closed = false
  let established = false
  const finish = (error: Error | null) => {
    if (closed) return
    closed = true
    ev.onClose(error)
  }

  if (!isPublicIPv4(host)) {
    queueMicrotask(() => finish(new Error(`refused: ${host} is not public`)))
    return {
      write() {},
      end() {},
      destroy() {
        closed = true
      },
      pause() {},
      resume() {},
      buffered: 0,
    }
  }

  const s = proxy
    ? net.connect({ host: proxy.host, port: proxy.port, allowHalfOpen: true, noDelay: true })
    : net.connect({ host, port, allowHalfOpen: true, noDelay: true })
  sockets.add(s)
  const timer = setTimeout(() => s.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS)
  const ready = (rest?: Buffer) => {
    clearTimeout(timer)
    established = true
    ev.onConnect()
    if (rest?.length) ev.onData(new Uint8Array(rest))
  }

  if (proxy) {
    let header = Buffer.alloc(0)
    const onHeader = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if (end === -1) {
        if (header.length > MAX_PROXY_HEADER_BYTES) s.destroy(new Error('proxy header too long'))
        return
      }
      s.off('data', onHeader)
      const status = header.subarray(0, header.indexOf('\r\n')).toString('latin1')
      if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
        s.destroy(new Error(`proxy refused: ${status}`))
        return
      }
      s.on('data', onData)
      ready(header.subarray(end + 4))
    }
    s.on('connect', () =>
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    )
    s.on('data', onHeader)
  } else {
    s.on('connect', () => ready())
    s.on('data', onData)
  }

  function onData(b: Buffer) {
    ev.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
  }
  s.on('end', () => {
    if (established) ev.onEnd()
  })
  s.on('drain', () => ev.onDrain())
  s.on('error', () => {})
  s.on('close', () => {
    clearTimeout(timer)
    sockets.delete(s)
    finish(s.errored ?? null)
  })

  return {
    write: (u8) => {
      if (established) s.write(u8)
    },
    end: () => {
      s.end()
    },
    destroy: () => {
      closed = true
      s.destroy()
    },
    pause: () => {
      s.pause()
    },
    resume: () => {
      s.resume()
    },
    get buffered() {
      return s.writableLength
    },
  }
}
