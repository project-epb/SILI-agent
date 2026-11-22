import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import path from 'node:path'

import type { LinuxMachine } from './machine'

export interface BackupOptions {
  /** Where the `data-<time>.img.gz` files go. */
  dir: string
  /** Backups kept; older ones are deleted. */
  keep: number
  /**
   * Skip a backup that would leave less than this share of the host's disk
   * free. The host runs the whole bot; it must never fill up for a backup.
   */
  minFreeRatio: number
}

export type BackupResult =
  | { status: 'done'; file: string; bytes: number }
  | { status: 'skipped'; reason: string }

const NAME = /^data-(\d{8}-\d{6})\.img\.gz$/

/** Newest backups first. */
export async function listBackups(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => NAME.test(n)).sort().reverse()
}

/** When the newest backup was written; undefined when there is none. */
export async function lastBackupAt(dir: string): Promise<Date | undefined> {
  const [newest] = await listBackups(dir)
  return newest ? (await stat(path.join(dir, newest))).mtime : undefined
}

/**
 * Copy the data disk while the machine runs: sync, a sparse copy (a second
 * or two), then compress the copy. The copy is what the disk would hold had
 * the machine lost power at that moment; ext4's journal recovers it.
 */
export async function backupDisk(
  machine: LinuxMachine,
  dataDir: string,
  opts: BackupOptions
): Promise<BackupResult> {
  await mkdir(opts.dir, { recursive: true })
  const disk = path.join(dataDir, 'data.img')
  const allocated = (await stat(disk)).blocks * 512
  const fs = await statfs(opts.dir)
  const total = fs.blocks * fs.bsize
  const free = fs.bavail * fs.bsize
  // The uncompressed copy and the archive exist together for a moment.
  const after = free - 2 * allocated
  if (after / total < opts.minFreeRatio)
    return {
      status: 'skipped',
      reason: `host disk would drop to ${gib(after)} free of ${gib(total)} (under ${Math.round(opts.minFreeRatio * 100)}%)`,
    }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const copy = path.join(opts.dir, `.copy-${stamp}.img`)
  const part = path.join(opts.dir, `.data-${stamp}.img.gz.part`)
  const file = path.join(opts.dir, `data-${stamp}.img.gz`)
  try {
    await machine.sync()
    await run('cp', ['--sparse=always', disk, copy])
    await run('gzip', ['-1', '-c', copy], part)
    await rename(part, file)
  } finally {
    await rm(copy, { force: true })
    await rm(part, { force: true })
  }
  for (const old of (await listBackups(opts.dir)).slice(opts.keep))
    await rm(path.join(opts.dir, old), { force: true })
  return { status: 'done', file, bytes: (await stat(file)).size }
}

async function run(cmd: string, args: string[], stdoutFile?: string): Promise<void> {
  const child = spawn(cmd, args, { stdio: ['ignore', stdoutFile ? 'pipe' : 'ignore', 'pipe'] })
  // The child closing does not mean the file is written; wait for both.
  const written = stdoutFile
    ? new Promise<void>((resolve, reject) =>
        child.stdout!.pipe(createWriteStream(stdoutFile)).on('finish', resolve).on('error', reject)
      )
    : Promise.resolve()
  let stderr = ''
  child.stderr!.on('data', (d) => (stderr += d))
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`))
    )
  })
  await Promise.all([exited, written])
}

function gib(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`
}
