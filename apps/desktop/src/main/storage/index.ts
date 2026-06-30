import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

let _db: Database.Database | undefined

const __dirname = dirname(fileURLToPath(import.meta.url))

export const initStorage = async (dbPath: string): Promise<void> => {
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('synchronous = NORMAL')
  await runMigrations(_db)
}

export const db = (): Database.Database => {
  if (!_db) throw new Error('storage not initialized')
  return _db
}

export const closeStorage = async (): Promise<void> => {
  _db?.close()
  _db = undefined
}

/**
 * 解析 migrations 目录的位置：
 *   dev 模式：out/main/migrations（vite 复制；若未复制，回退到源码路径）
 *   打包后：在 asar 内 out/main/migrations
 */
const resolveMigrationsDir = (): string => {
  const candidates = [
    join(__dirname, 'migrations'),
    join(__dirname, '..', 'migrations'),
    // dev 模式 fallback：源码路径
    join(app.getAppPath(), 'src/main/migrations'),
    join(process.cwd(), 'apps/desktop/src/main/migrations'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`migrations directory not found; tried: ${candidates.join(', ')}`)
}

const runMigrations = async (database: Database.Database): Promise<void> => {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  )
  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r: any) => r.version),
  )
  const migrationsDir = resolveMigrationsDir()
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const m = file.match(/^(\d+)_.*\.sql$/)
    if (!m) continue
    const ver = Number(m[1])
    if (applied.has(ver)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const tx = database.transaction(() => {
      database.exec(sql)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(ver, Date.now())
    })
    tx()
  }
}

export { ProjectRepo } from './project-repo.js'
export { StageRepo } from './stage-repo.js'
export { SegmentRepo } from './segment-repo.js'
export { CostRepo } from './cost-repo.js'
export { CharacterRepo } from './character-repo.js'

