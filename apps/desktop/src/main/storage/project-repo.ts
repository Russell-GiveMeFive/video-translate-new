import { randomUUID } from 'node:crypto'
import type {
  CreateProjectInput,
  ProjectDetail,
  ProjectFilter,
  ProjectId,
  ProjectStatus,
  ProjectSummary,
  StageName,
  StageRecord,
} from '@dramaprime/core-types'
import { asProjectId } from '@dramaprime/core-types'
import { db } from './index.js'

const rowToSummary = (r: any): ProjectSummary => ({
  id: asProjectId(r.id),
  name: r.name,
  sourceLang: r.source_lang,
  targetLang: r.target_lang,
  status: r.status,
  currentStage: r.current_stage,
  sourceDurMs: r.source_dur_ms,
  costTotalCents: r.cost_total_cents,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class ProjectRepo {
  static create(input: CreateProjectInput): ProjectId {
    const id = asProjectId(randomUUID())
    const now = Date.now()
    db().prepare(
      `INSERT INTO projects (
        id, name, source_lang, target_lang, source_path,
        status, current_stage, config_json, cost_total_cents,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      input.name,
      'zh',
      input.config.targetLang,
      input.sourcePath,
      'created' as ProjectStatus,
      null,
      JSON.stringify(input.config),
      now,
      now,
    )
    return id
  }

  static get(id: ProjectId): ProjectDetail {
    const row = db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as any
    if (!row) throw new Error('project not found: ' + id)
    const stages = db()
      .prepare('SELECT * FROM stages WHERE project_id = ?')
      .all(id) as any[]
    return {
      ...rowToSummary(row),
      sourcePath: row.source_path,
      sourceSizeBytes: row.source_size_bytes,
      config: JSON.parse(row.config_json),
      stages: stages.map(rowToStageRecord),
    }
  }

  static list(filter?: ProjectFilter): ProjectSummary[] {
    const where: string[] = []
    const params: any[] = []
    if (filter?.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`)
      params.push(...filter.status)
    }
    if (filter?.targetLang?.length) {
      where.push(`target_lang IN (${filter.targetLang.map(() => '?').join(',')})`)
      params.push(...filter.targetLang)
    }
    if (filter?.search) {
      where.push(`name LIKE ?`)
      params.push(`%${filter.search}%`)
    }
    const order =
      filter?.sort === 'name_asc'
        ? 'name ASC'
        : filter?.sort === 'created_desc'
          ? 'created_at DESC'
          : 'updated_at DESC'
    const sql = `SELECT * FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 500`
    return (db().prepare(sql).all(...params) as any[]).map(rowToSummary)
  }

  static updateStatus(id: ProjectId, status: ProjectStatus, currentStage?: StageName | null): void {
    db().prepare(
      `UPDATE projects SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?`,
    ).run(status, currentStage ?? null, Date.now(), id)
  }

  static delete(id: ProjectId): void {
    db().prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  static addCost(id: ProjectId, cents: number): void {
    db().prepare(
      `UPDATE projects SET cost_total_cents = cost_total_cents + ?, updated_at = ? WHERE id = ?`,
    ).run(cents, Date.now(), id)
  }

  /** preprocess stage 完成后回写源视频元数据 */
  static setSourceMeta(
    id: ProjectId,
    meta: { durationMs?: number; sizeBytes?: number },
  ): void {
    const fields: string[] = []
    const params: any[] = []
    if (meta.durationMs != null) {
      fields.push('source_dur_ms = ?')
      params.push(meta.durationMs)
    }
    if (meta.sizeBytes != null) {
      fields.push('source_size_bytes = ?')
      params.push(meta.sizeBytes)
    }
    if (!fields.length) return
    params.push(Date.now(), id)
    db()
      .prepare(`UPDATE projects SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...params)
  }
}

const rowToStageRecord = (r: any): StageRecord => ({
  stage: r.stage,
  status: r.status,
  attempts: r.attempts,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  durationMs: r.duration_ms,
  costCents: r.cost_cents,
  outputs: r.outputs_json ? JSON.parse(r.outputs_json) : {},
  error: r.error_json,
})
