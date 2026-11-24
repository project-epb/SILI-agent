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
import NativeSQLite from '@sili/database-sqlite-native'

export function installSQLiteBackup(app: App) {
  if (process.env.SILI_DATABASE !== 'sqlite') return

  const driver = app.database.select('user').driver as SQLite | NativeSQLite
  const ready = join(dirname(driver.path), '.sili-db-snapshot.sqlite')
  const pending = ready + '.pending'
  const logger = app.logger('sqlite-backup')

  let running = false
  const snapshot = async () => {
    if (running || existsSync(ready)) return
    running = true
    try {
      rmSync(pending, { force: true })
      const fd = openSync(pending, 'wx', 0o600)
      try {
        // Use the live connection to take a consistent snapshot.
        if (driver instanceof NativeSQLite) await driver.backup(pending)
        else driver.db.run('VACUUM INTO ?', [pending])
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
    } finally {
      running = false
    }
  }
  process.on('SIGUSR2', snapshot)
  app.on('dispose', () => {
    process.off('SIGUSR2', snapshot)
  })
}
