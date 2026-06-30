import type { Character, CharacterId, ProjectId } from '@dramaprime/core-types'
import { asCharacterId, asProjectId } from '@dramaprime/core-types'
import { db } from './index.js'

const rowToCharacter = (r: any): Character => ({
  id: asCharacterId(r.id),
  projectId: asProjectId(r.project_id),
  name: r.name,
  speakerId: r.speaker_id,
  gender: r.gender,
  ageBand: r.age_band,
  voiceId: r.voice_id,
  voiceStatus: r.voice_status,
  voiceExpiresAt: r.voice_expires_at,
  needsReclone: !!r.needs_reclone,
  samplePath: r.sample_path,
  sampleScore: r.sample_score,
  segmentCount: 0, // 由调用方按需聚合
  // v0.4.16 用户手动开关：mix-render 用 src_audio_path 代替 TTS
  useOriginalAudio: !!r.use_original_audio,
})

export interface CharacterInsert {
  id: string
  projectId: ProjectId
  name: string | null
  speakerId: string
  gender: 'male' | 'female' | 'unknown' | null
  ageBand: 'child' | 'young' | 'adult' | 'elder' | null
  voiceId?: string | null
  voiceStatus?: 'system' | 'temp' | 'permanent' | null
  voiceExpiresAt?: number | null
  needsReclone?: boolean
  samplePath?: string | null
  sampleScore?: number | null
  sampleDurMs?: number | null
}

export class CharacterRepo {
  static list(projectId: ProjectId): Character[] {
    const rows = db()
      .prepare('SELECT * FROM characters WHERE project_id = ?')
      .all(projectId) as any[]
    return rows.map(rowToCharacter)
  }

  static get(id: CharacterId): Character | null {
    const row = db().prepare('SELECT * FROM characters WHERE id = ?').get(id) as any
    return row ? rowToCharacter(row) : null
  }

  static insert(input: CharacterInsert): void {
    db()
      .prepare(
        `INSERT INTO characters
         (id, project_id, name, speaker_id, gender, age_band,
          voice_id, voice_status, voice_expires_at, needs_reclone,
          sample_path, sample_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.name,
        input.speakerId,
        input.gender,
        input.ageBand,
        input.voiceId ?? null,
        input.voiceStatus ?? null,
        input.voiceExpiresAt ?? null,
        input.needsReclone ? 1 : 0,
        input.samplePath ?? null,
        input.sampleScore ?? null,
      )
  }

  static clearForProject(projectId: ProjectId): void {
    db().prepare('DELETE FROM characters WHERE project_id = ?').run(projectId)
  }

  static rename(id: CharacterId, name: string): void {
    db()
      .prepare('UPDATE characters SET name = ? WHERE id = ?')
      .run(name, id)
  }

  /** 写入克隆完成后的 voice_id 与有效期 */
  static setVoice(
    id: CharacterId,
    voice: { voiceId: string; voiceStatus: 'system' | 'temp' | 'permanent'; voiceExpiresAt: number | null },
  ): void {
    db()
      .prepare(
        `UPDATE characters
         SET voice_id = ?, voice_status = ?, voice_expires_at = ?, needs_reclone = 0
         WHERE id = ?`,
      )
      .run(voice.voiceId, voice.voiceStatus, voice.voiceExpiresAt, id)
  }

  /** 设置克隆所用的样本路径 */
  static setSample(id: CharacterId, samplePath: string, score?: number): void {
    db()
      .prepare(`UPDATE characters SET sample_path = ?, sample_score = ? WHERE id = ?`)
      .run(samplePath, score ?? null, id)
  }

  /**
   * v0.4.16 切换"使用原音"开关
   * true = mix-render 跳过 TTS、用 segments.src_audio_path
   */
  static setUseOriginalAudio(id: CharacterId, useOriginalAudio: boolean): void {
    db()
      .prepare(`UPDATE characters SET use_original_audio = ? WHERE id = ?`)
      .run(useOriginalAudio ? 1 : 0, id)
  }
}
