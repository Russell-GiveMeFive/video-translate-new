import type { CostEntry } from '@dramaprime/core-types'
import { db } from './index.js'

export class CostRepo {
  static insert(entry: CostEntry): void {
    db().prepare(
      `INSERT INTO cost_entries (project_id, stage, provider, model, units, unit_kind, cents, request_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.projectId ?? null,
      entry.stage ?? null,
      entry.provider,
      entry.model,
      entry.units,
      entry.unitKind,
      entry.cents,
      entry.requestId ?? null,
      entry.ts,
    )
  }

  static totalCents(projectId?: string): number {
    if (projectId) {
      const r = db().prepare('SELECT total_cents FROM v_project_cost WHERE project_id = ?').get(projectId) as any
      return r?.total_cents ?? 0
    }
    const r = db().prepare('SELECT SUM(cents) AS c FROM cost_entries').get() as any
    return r?.c ?? 0
  }
}
