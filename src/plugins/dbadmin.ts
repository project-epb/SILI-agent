import { Context, h } from '@koishijs/core'

import BasePlugin from '~/_boilerplate'

import JSON5 from 'json5'
import { resolve } from 'path'

enum FilePath {
  dbDumpScript = './scripts/db_dump.ps1',
}

export default class PluginDatabaseAdmin extends BasePlugin {
  static inject = ['shell', 'html']

  constructor(ctx: Context) {
    super(ctx, {}, 'dbadmin')

    ctx.command('admin/dbadmin', '数据库管理', { authority: 4 })

    ctx
      .command('dbadmin.dump', '备份数据库', { authority: 4 })
      .action(async ({ session }) => {
        const script = resolve(ctx.baseDir, FilePath.dbDumpScript)
        console.info(script)
        try {
          const { output } = await ctx.root.shell.exec(
            `${script} -silent 1`,
            console.info
          )
          return output
        } catch (e) {
          return e?.output || '' + e
        }
      })

    ctx
      .command('dbadmin.get <table:string> <extra:text>', '查询数据库', {
        authority: 4,
      })
      .example(`dbadmin.get table_name {foo:'bar'} /// baz,qux`)
      .action(async ({ session }, table, extraRaw) => {
        const [queryRaw, fieldsRaw] = extraRaw?.split('///') || []
        if (!table || !queryRaw) return session.execute('dbadmin get -h')
        const query = JSON5.parse(queryRaw)
        let fields = fieldsRaw?.trim()
          ? fieldsRaw
              .trim()
              .split(',')
              .map((v) => v.trim())
              .filter((v) => !!v)
          : ['id']
        if (fields.includes('*')) {
          fields = undefined
        }
        this.logger.info(
          'get',
          table,
          {
            extraRaw,
            queryRaw,
            fieldsRaw,
          },
          { query, fields }
        )
        const res = await session.app.database.get(table as any, query, {
          fields,
          limit: 1,
        })
        const img = await ctx.html.hljs(JSON.stringify(res, null, 2), 'json')
        return img ? h.img(img, 'image/jpg') : '出现了一些问题'
      })

    ctx
      .command('dbadmin.set <table:string> <extra:text>', '更新数据库', {
        authority: 4,
      })
      .action(async ({ session }, table, extraRaw) => {
        if (!table || !extraRaw) return session.execute('dbadmin set -h')
        const [whereRaw, updateRaw] = extraRaw?.split('///') || []
        if (!whereRaw || !updateRaw) return session.execute('dbadmin set -h')
        const where = JSON5.parse(whereRaw)
        const update = JSON5.parse(updateRaw)
        this.logger.info(
          'set',
          table,
          { extraRaw, whereRaw, updateRaw },
          { where, update }
        )
        const res = await session.app.database.set(table as any, where, update)
        return '更新成功'
      })
  }
}
