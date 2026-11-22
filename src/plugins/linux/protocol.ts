import type { ProxyAddress } from './net-backend'

/** Messages between LinuxMachine and its worker thread. */

export interface BootOptions {
  /** Host directory holding the data disk and the distro image cache. */
  dataDir: string
  memoryMiB: number
  proxy?: ProxyAddress
}

export type HostMessage =
  | { type: 'boot'; opts: BootOptions }
  | {
      type: 'exec'
      id: number
      argv: string[]
      input?: Uint8Array
      user?: string
      /** None: runs until it ends or is aborted. */
      timeoutMs?: number
      maxBuffer?: number
    }
  | { type: 'abort'; id: number }
  | { type: 'shutdown' }

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'boot-error'; message: string }
  | { type: 'exited'; reason: string }
  | {
      type: 'result'
      id: number
      stdout: Uint8Array
      stderr: Uint8Array
      exitCode: number | null
      signal: number | null
    }
  | {
      type: 'error'
      id: number
      /** TIMEOUT, ABORTED, or unkernel's own code (ENOBUFS, …). */
      code: string
      message: string
    }
