import type { ProjectId, StageName, StageResult } from '@dramaprime/core-types'
import { db } from './index.js'

export class StageRepo {
  static begin(projectId: ProjectId, stage: StageName): void {
    const now = Date.now()
    db().prepare(
      `INSERT INTO stages (project_id, stage, version, status, attempts, started_at)
       VALUES (?, ?, 1, 'running', 1, ?)
       ON CONFLICT(project_id, stage) DO UPDATE SET
         status = 'running',
         attempts = attempts + 1,
         started_at = excluded.started_at,
         ended_at = NULL,
         error_json = NULL`,
    ).run(projectId, stage, now)
  }

  static finish(
    projectId: ProjectId,
    stage: StageName,
    result: StageResult,
    durationMs: number,
  ): void {
    const now = Date.now()
    if (result.kind === 'ok') {
      db().prepare(
        `UPDATE stages SET status = 'done', ended_at = ?, duration_ms = ?, outputs_json = ?, error_json = NULL
         WHERE project_id = ? AND stage = ?`,
      ).run(now, durationMs, JSON.stringify(result.outputs), projectId, stage)
    } else if (result.kind === 'skipped') {
      db().prepare(
        `UPDATE stages SET status = 'skipped', ended_at = ?, duration_ms = ?, error_json = ?
         WHERE project_id = ? AND stage = ?`,
      ).run(now, durationMs, result.reason, projectId, stage)
    } else {
      db().prepare(
        `UPDATE stages SET status = 'failed', ended_at = ?, duration_ms = ?, error_json = ?
         WHERE project_id = ? AND stage = ?`,
      ).run(now, durationMs, JSON.stringify(result.error), projectId, stage)
    }
  }

  static load(projectId: ProjectId): Partial<Record<StageName, StageResult>> {
    const rows = db()
      .prepare('SELECT * FROM stages WHERE project_id = ?')
      .all(projectId) as any[]
    const out: Partial<Record<StageName, StageResult>> = {}
    for (const r of rows) {
      if (r.status === 'done') {
        out[r.stage as StageName] = {
          kind: 'ok',
          outputs: r.outputs_json ? JSON.parse(r.outputs_json) : {},
          durationMs: r.duration_ms ?? 0,
        }
      } else if (r.status === 'failed') {
        out[r.stage as StageName] = {
          kind: 'failed',
          error: r.error_json
            ? JSON.parse(r.error_json)
            : { code: 'unknown', message: 'unknown', retriable: false },
        }
      }
    }
    return out
  }

  static reset(projectId: ProjectId, stage: StageName): void {
    db().prepare('DELETE FROM stages WHERE project_id = ? AND stage = ?').run(projectId, stage)
  }

  /** 清掉项目的所有 stage 记录（"全部重跑"用） */
  static clearAll(projectId: ProjectId): void {
    db().prepare('DELETE FROM stages WHERE project_id = ?').run(projectId)
  }

  /** 清掉指定 stage 及其下游的所有 stage 记录（"从某 stage 重跑"用） */
  static resetCascade(projectId: ProjectId, fromStage: StageName, allStages: readonly StageName[]): void {
    const idx = allStages.indexOf(fromStage)
    if (idx < 0) return
    const downstream = allStages.slice(idx)
    const placeholders = downstream.map(() => '?').join(',')
    db()
      .prepare(`DELETE FROM stages WHERE project_id = ? AND stage IN (${placeholders})`)
      .run(projectId, ...downstream)
  }
}
