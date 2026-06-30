import type { ProjectId, VoiceId } from '@dramaprime/core-types'
import { db } from './index.js'

/**
 * v0.4.12 跨项目音色资产库 —— 收集所有项目复刻过的 MiniMax voice_id
 *
 * 物理模型（已有 0001_init.sql 定义，本文件不重新 CREATE TABLE）：
 *   voice_assets (
 *     id                  TEXT PRIMARY KEY,    -- 内部 uuid
 *     name                TEXT NOT NULL,        -- 用户可改的易记名
 *     voice_id            TEXT NOT NULL UNIQUE, -- MiniMax voice_id
 *     provider            TEXT,
 *     status              TEXT,
 *     expires_at          INTEGER,
 *     tags_json           TEXT,                 -- JSON 数组（v0.4.12 用 tags 存"来自哪个项目 + 角色"）
 *     origin_project_id   TEXT,
 *     sample_path         TEXT,
 *     created_at          INTEGER
 *   )
 *
 * 设计要点：
 *   - 同一 voice_id 可能被多个项目复用（同一克隆音色在 EP01 用了又在 EP02 用了）—— 这里只记"来自哪里"
 *   - name 由用户重命名：仅影响音色库展示，不影响历史项目角色
 *   - 删除：不动其他项目对 voice_id 的引用，只从音色库移除
 */
export interface VoiceAssetRow {
  id: string
  name: string
  voiceId: string
  provider: string
  status: string
  expiresAt: number | null
  tags: string[]
  originProjectId: string | null
  samplePath: string | null
  createdAt: number
}

export class VoiceAssetRepo {
  /**
   * 复刻成功时记录一条。
   * 用 voice_id 作为内部 id 简化管理（PK 唯一）。
   * 若 voice_id 已存在（同一音色被多个项目复用）→ 保留最早来源、覆盖名字
   */
  static record(args: {
    voiceId: VoiceId
    defaultName: string
    originProjectId: ProjectId
    originCharacterName: string
  }): void {
    const now = Date.now()
    const tags = JSON.stringify([`char:${args.originCharacterName}`])
    db()
      .prepare(
        `INSERT INTO voice_assets
         (id, name, voice_id, provider, status, expires_at, tags_json, origin_project_id, sample_path, created_at)
         VALUES (?, ?, ?, 'MiniMax', 'temp', NULL, ?, ?, NULL, ?)
         ON CONFLICT(voice_id) DO NOTHING`,
      )
      .run(
        args.voiceId,
        args.defaultName,
        args.voiceId,
        tags,
        args.originProjectId,
        now,
      )
  }

  /** 列出所有已记录的 voice_id（按时间倒序） */
  static list(): VoiceAssetRow[] {
    const rows = db()
      .prepare(
        `SELECT id, name, voice_id, provider, status, expires_at, tags_json, origin_project_id, sample_path, created_at
         FROM voice_assets ORDER BY created_at DESC`,
      )
      .all() as Array<{
        id: string
        name: string
        voice_id: string
        provider: string
        status: string
        expires_at: number | null
        tags_json: string | null
        origin_project_id: string | null
        sample_path: string | null
        created_at: number
      }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      voiceId: r.voice_id,
      provider: r.provider,
      status: r.status,
      expiresAt: r.expires_at,
      tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [],
      originProjectId: r.origin_project_id,
      samplePath: r.sample_path,
      createdAt: r.created_at,
    }))
  }

  /** 改默认名（仅影响音色库展示，不影响历史项目角色） */
  static rename(voiceId: VoiceId, newName: string): void {
    db()
      .prepare(`UPDATE voice_assets SET name = ? WHERE voice_id = ?`)
      .run(newName, voiceId)
  }

  /** 从音色库移除（不影响其他项目对该 voice_id 的使用） */
  static remove(voiceId: VoiceId): void {
    db()
      .prepare(`DELETE FROM voice_assets WHERE voice_id = ?`)
      .run(voiceId)
  }
}