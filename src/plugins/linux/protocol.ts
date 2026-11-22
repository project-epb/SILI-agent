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
  /** Flush the guest's page cache onto the data disk file. */
  | { type: 'sync'; id: number }
  /** An interactive login shell on a pty (the admin page's terminal). */
  | { type: 'pty-open'; id: number; user: string; cols: number; rows: number }
  | { type: 'pty-input'; id: number; data: Uint8Array }
  | { type: 'pty-resize'; id: number; cols: number; rows: number }
  | { type: 'pty-close'; id: number }
  | { type: 'shutdown' }

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'synced'; id: number }
  | { type: 'pty-opened'; id: number; pid: number }
  | { type: 'pty-output'; id: number; data: Uint8Array }
  /** The shell ended, or failed to start (`error`). */
  | { type: 'pty-ended'; id: number; exitCode: number | null; error?: string }
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
