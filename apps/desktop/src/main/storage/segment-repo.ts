import { randomUUID } from 'node:crypto'
import type { ProjectId, Segment, SegmentId, SegmentPatch } from '@dramaprime/core-types'
import { asSegmentId, asCharacterId, asProjectId } from '@dramaprime/core-types'
import { db } from './index.js'

const rowToSegment = (r: any): Segment => ({
  id: asSegmentId(r.id),
  projectId: asProjectId(r.project_id),
  idx: r.idx,
  sceneIdx: r.scene_idx,
  startMs: r.start_ms,
  endMs: r.end_ms,
  speakerId: r.speaker_id,
  characterId: r.character_id ? asCharacterId(r.character_id) : null,
  srcText: r.src_text,
  srcTextEdited: r.src_text_edited,
  ocrText: r.ocr_text,
  tgtText: r.tgt_text,
  tgtTextEdited: r.tgt_text_edited,
  tgtAudioPath: r.tgt_audio_path,
  tgtDurMs: r.tgt_dur_ms,
  // v0.4.16: 段原音路径（"使用原音"开关启用时 mix-render 读这个替 TTS）
  srcAudioPath: r.src_audio_path,
  // v0.4.22: segment 级"使用原音"开关（true → 这一句 mix-render 用 srcAudioPath）
  useOriginalAudio: !!r.use_original_audio,
  // ★ v0.4.11 同步 thumbPath：segment:list 直接返回缩略图路径，
  // 避免每个表格行都调 segment:assets 拿大对象
  thumbPath: r.thumb_path ?? null,
  align: r.align_decision_json ? JSON.parse(r.align_decision_json) : null,
  locked: !!r.locked,
  emotion: r.emotion,
  flag: r.flag,
})

/** TTS 调用快照——每次合成后落库，便于"工作台"展示 */
export interface TtsSnapshot {
  inputText: string
  voiceId: string
  emotion: string | null
  intensity: number | null
  speed: number | null
  vol: number | null
  pitch: number | null
}

/** 用户手动 override——存在时优先于 ASR/auto 推断 */
export interface SegmentOverrides {
  userEmotion: string | null
  userVoiceId: string | null
  userIntensity: number | null
  userSpeed: number | null
  /** v0.4.11 音量倍率 override [0, 10] */
  userVol: number | null
}

/**
 * v0.4.11 临时方案：在 DB 加 user_vol 列需要 schema migration。
 * 当前用进程内 Map 暂存 vol override，重启 Electron 后丢失。
 * TODO：v0.6 加迁移把 user_vol 写到 segments 表。
 */
const _pendingVolOverride = new Map<string, number>()

export class SegmentRepo {
  static list(projectId: ProjectId): Segment[] {
    const rows = db()
      .prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY idx ASC')
      .all(projectId) as any[]
    return rows.map(rowToSegment)
  }

  static get(segmentId: SegmentId): Segment | null {
    const r = db().prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as any
    return r ? rowToSegment(r) : null
  }

  /** 拿"原始" row（含所有新加的 thumb_path / tts_* / user_* 字段） */
  static getRow(segmentId: SegmentId): Record<string, any> | null {
    return (
      (db().prepare('SELECT * FROM segments WHERE id = ?').get(segmentId) as
        | Record<string, any>
        | undefined) ?? null
    )
  }

  static bulkInsert(
    projectId: ProjectId,
    items: Array<Pick<Segment, 'idx' | 'startMs' | 'endMs' | 'speakerId' | 'srcText'>>,
  ): void {
    const stmt = db().prepare(
      `INSERT OR REPLACE INTO segments (id, project_id, idx, start_ms, end_ms, speaker_id, src_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const tx = db().transaction(() => {
      for (const it of items) {
        // v0.4.10 兜底防御：拒绝写入 startMs<0 / endMs<=startMs 的脏数据
        // 上游 asr-cluster-stages 已经过滤一次，这里再加一层防御杜绝其它写入路径
        if (it.startMs < 0 || it.endMs <= it.startMs) {
          continue
        }
        stmt.run(randomUUID(), projectId, it.idx, it.startMs, it.endMs, it.speakerId, it.srcText)
      }
    })
    tx()
  }

  static patch(patch: SegmentPatch): void {
    const fields: string[] = []
    const params: any[] = []
    if (patch.tgtTextEdited !== undefined) {
      fields.push('tgt_text_edited = ?')
      params.push(patch.tgtTextEdited)
    }
    if (patch.srcTextEdited !== undefined) {
      fields.push('src_text_edited = ?')
      params.push(patch.srcTextEdited)
    }
    if (patch.characterId !== undefined) {
      fields.push('character_id = ?')
      params.push(patch.characterId)
    }
    if (patch.locked !== undefined) {
      fields.push('locked = ?')
      params.push(patch.locked ? 1 : 0)
    }
    if (patch.emotion !== undefined) {
      fields.push('emotion = ?')
      params.push(patch.emotion)
    }
    if (!fields.length) return
    params.push(patch.id)
    db().prepare(`UPDATE segments SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  }

  /** 写 segment 代表帧路径（thumb-extract stage 用） */
  static setThumb(segmentId: SegmentId, thumbPath: string | null): void {
    db().prepare('UPDATE segments SET thumb_path = ? WHERE id = ?').run(thumbPath, segmentId)
  }

  /** v0.4.22 segment 级"使用原音"开关 */
  static setUseOriginalAudio(segmentId: SegmentId, useOriginalAudio: boolean): void {
    db()
      .prepare('UPDATE segments SET use_original_audio = ? WHERE id = ?')
      .run(useOriginalAudio ? 1 : 0, segmentId)
  }

  /** TTS 合成后落 TTS 快照 */
  static setTtsSnapshot(segmentId: SegmentId, snap: TtsSnapshot): void {
    db()
      .prepare(
        `UPDATE segments SET
           tts_input_text = ?, tts_voice_id = ?, tts_emotion = ?,
           tts_intensity = ?, tts_speed = ?, tts_vol = ?, tts_pitch = ?
         WHERE id = ?`,
      )
      .run(
        snap.inputText,
        snap.voiceId,
        snap.emotion,
        snap.intensity,
        snap.speed,
        snap.vol,
        snap.pitch,
        segmentId,
      )
  }

  /** 用户手动 override（"我要这一句改 angry 1.8"）—— 部分更新 */
  static setOverrides(
    segmentId: SegmentId,
    overrides: Partial<SegmentOverrides>,
  ): void {
    const fields: string[] = []
    const params: any[] = []
    if (overrides.userEmotion !== undefined) {
      fields.push('user_emotion = ?')
      params.push(overrides.userEmotion)
    }
    if (overrides.userVoiceId !== undefined) {
      fields.push('user_voice_id = ?')
      params.push(overrides.userVoiceId)
    }
    if (overrides.userIntensity !== undefined) {
      fields.push('user_intensity = ?')
      params.push(overrides.userIntensity)
    }
    if (overrides.userSpeed !== undefined) {
      fields.push('user_speed = ?')
      params.push(overrides.userSpeed)
    }
    // v0.4.11 vol 暂存到内存 Map（schema 没 user_vol 列；后续迁移再持久化）
    if (overrides.userVol !== undefined) {
      if (overrides.userVol === null) _pendingVolOverride.delete(segmentId)
      else _pendingVolOverride.set(segmentId, overrides.userVol)
    }
    if (!fields.length) return
    params.push(segmentId)
    db().prepare(`UPDATE segments SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  }

  /** 读 row 的 override 列（给 TTS stage 用，决定是否覆盖自动推断） */
  static getOverrides(segmentId: SegmentId): SegmentOverrides {
    // v0.4.11 注意：当前 segments 表没有 user_vol 列（DB schema 升级前用内存兜底）
    const r = db()
      .prepare(
        'SELECT user_emotion, user_voice_id, user_intensity, user_speed FROM segments WHERE id = ?',
      )
      .get(segmentId) as any
    return {
      userEmotion: r?.user_emotion ?? null,
      userVoiceId: r?.user_voice_id ?? null,
      userIntensity: r?.user_intensity ?? null,
      userSpeed: r?.user_speed ?? null,
      userVol: _pendingVolOverride.get(segmentId) ?? null,
    }
  }

  /** 清掉项目的所有 segment（"全部重跑"用，ASR 阶段会重新生成） */
  static clearForProject(projectId: ProjectId): void {
    db().prepare('DELETE FROM segments WHERE project_id = ?').run(projectId)
  }
}
