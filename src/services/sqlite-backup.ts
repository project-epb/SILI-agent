import type { App } from 'koishi'

import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type SQLite from '@koishijs/plugin-database-sqlite'

export function installSQLiteBackup(app: App) {
  if (process.env.SILI_DATABASE !== 'sqlite') return

  const driver = app.database.select('user').driver as SQLite
  const ready = join(dirname(driver.path), '.sili-db-snapshot.sqlite')
  const pending = ready + '.pending'
  const logger = app.logger('sqlite-backup')

  const snapshot = () => {
    if (existsSync(ready)) return
    try {
      rmSync(pending, { force: true })
      const fd = openSync(pending, 'wx', 0o600)
      try {
        // This VFS is used by the live connection, so the snapshot must be
        // taken there before an external process opens the resulting file.
        driver.db.run('VACUUM INTO ?', [pending])
        fchmodSync(fd, 0o600)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(pending, ready)
      logger.info('snapshot ready')
    } catch (error) {
      rmSync(pending, { force: true })
      logger.error('snapshot failed', error)
    }
  }
  process.on('SIGUSR2', snapshot)
  app.on('dispose', () => {
    process.off('SIGUSR2', snapshot)
  })
}
