import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SegmentAssets, SegmentId, TtsInput } from '@dramaprime/core-types'
import { asCharacterId, asSegmentId } from '@dramaprime/core-types'
import { handle, type IpcContext } from './index.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { db } from '../storage/index.js'
import { providers } from '../providers/index.js'
import { getProjectDir } from '../orchestrator/index.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'
import { logger } from '../logger.js'

export const registerSegmentIpc = (_ctx: IpcContext): void => {
  handle('segment:list', async ({ projectId }) => SegmentRepo.list(projectId))

  handle('segment:update', async (patch) => {
    SegmentRepo.patch(patch)
  })

  /** v0.4.22 segment 级"使用原音" */
  handle('segment:set-use-original-audio', async ({ segmentId, useOriginalAudio }) => {
    SegmentRepo.setUseOriginalAudio(asSegmentId(segmentId), !!useOriginalAudio)
  })

  handle('segment:tts-regenerate', async (_input) => {
    throw new Error('segment:tts-regenerate 已废弃，请用 segment:resynth')
  })

  // ── 拿到一个 segment 的所有可视化资产路径 ───────────────────────
  handle('segment:assets', async ({ projectId, segmentId }): Promise<SegmentAssets> => {
    const segId = asSegmentId(segmentId)
    const row = SegmentRepo.getRow(segId)
    if (!row) throw new Error(`segment 不存在: ${segmentId}`)
    const project = ProjectRepo.get(projectId)
    const projectDir = getProjectDir(projectId)

    // 原音轨片段：从 demix 后的 vocals.wav（如果有）或源视频 切出 startMs-endMs
    // 缓存在 segment-audio/<segId>.mp3，避免每次都裁
    const segAudioDir = join(projectDir, 'segment-audio')
    const srcAudioPath = join(segAudioDir, `${segId}.mp3`)
    if (!existsSync(srcAudioPath)) {
      try {
        await mkdir(segAudioDir, { recursive: true })
        const ffmpeg = requireFfmpeg()
        const sourceForCut = join(projectDir, 'stems', 'vocals.wav')
        const useVocals = existsSync(sourceForCut)
        const startSec = (row.start_ms / 1000).toFixed(3)
        const durSec = ((row.end_ms - row.start_ms) / 1000).toFixed(3)
        await runCmd(ffmpeg, [
          '-ss',
          startSec,
          '-t',
          durSec,
          '-i',
          useVocals ? sourceForCut : project.sourcePath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '24000',
          '-b:a',
          '96k',
          '-y',
          srcAudioPath,
        ])
      } catch (err) {
        logger.warn({ segId, err: String(err) }, '裁切原音片段失败')
      }
    }

    // 角色克隆样本路径（如果有）
    // v0.4.22: 旧项目兜底——character 还没 samplePath 时，惰性触发 reclone-extended 补刻
    //          （只补 samplePath，不重新调 MiniMax clone API；避免每次开 drawer 都烧钱）
    let cloneSamplePath: string | null = null
    let characterName: string | null = null
    if (row.character_id) {
      const c = CharacterRepo.get(asCharacterId(row.character_id))
      if (c) {
        characterName = c.name
        if (c.samplePath && existsSync(c.samplePath)) {
          cloneSamplePath = c.samplePath
        } else {
          // 惰性生成 samplePath：拼接该角色所有 srcAudioPath → stream_loop 到 10.5s+
          // 不调 clone API（character 已经有 system voice_id 兜底）
          try {
            const generated = await lazyBuildCharacterSample(
              asCharacterId(row.character_id),
              projectId,
              projectDir,
            )
            if (generated) cloneSamplePath = generated
          } catch (err) {
            logger.warn({ characterId: row.character_id, err: String(err) }, '惰性补 samplePath 失败')
          }
        }
      }
    }

    return {
      segmentId: segId,
      startMs: row.start_ms,
      endMs: row.end_ms,
      thumbPath: row.thumb_path && existsSync(row.thumb_path) ? row.thumb_path : null,
      srcAudioPath: existsSync(srcAudioPath) ? srcAudioPath : null,
      characterId: row.character_id ? asCharacterId(row.character_id) : null,
      characterName,
      cloneSamplePath,
      ttsAudioPath:
        row.tgt_audio_path && existsSync(row.tgt_audio_path) ? row.tgt_audio_path : null,
      ttsDurMs: row.tgt_dur_ms ?? null,
      ttsInputText: row.tts_input_text ?? null,
      ttsVoiceId: row.tts_voice_id ?? null,
      ttsParams: row.tts_voice_id
        ? {
            emotion: row.tts_emotion ?? null,
            emotionIntensity: row.tts_intensity ?? null,
            speed: row.tts_speed ?? null,
            vol: row.tts_vol ?? null,
            pitch: row.tts_pitch ?? null,
          }
        : null,
    }
  })

  // ── 单 segment 重合成 ─────────────────────────────────────────
  handle('segment:resynth', async ({ projectId, segmentId, overrides }) => {
    const segId = asSegmentId(segmentId)
    const row = SegmentRepo.getRow(segId)
    if (!row) throw new Error(`segment 不存在: ${segmentId}`)
    const project = ProjectRepo.get(projectId)

    // 先把 overrides 持久化到 segments 表（让下次"全部重跑"也用这些）
    if (overrides) {
      // ★ v0.4.12 修复：空字符串 '' 等同于 null（用户填了 voiceId 后又清空的情况）
      // 否则 setOverrides 写库后下次读到空字符串覆盖了真实音色
      const normVoiceId = overrides.voiceId?.trim() || null
      const normEmotion = overrides.emotion?.trim() || null
      SegmentRepo.setOverrides(segId, {
        userEmotion: normEmotion,
        userVoiceId: normVoiceId,
        userIntensity: overrides.emotionIntensity ?? null,
        userSpeed: overrides.speed ?? null,
        // v0.4.11 持久化 vol override（暂存到 SegmentOverrides.userVol，
        // 走单独列之后这里改成标准字段；当前先放 SegmentOverrides 内存里）
        ...((overrides as any).vol != null ? { userVol: (overrides as any).vol } : {}),
      } as any)
      if (overrides.tgtText) {
        SegmentRepo.patch({ id: segId, tgtTextEdited: overrides.tgtText })
      }
    }

    // 重新读 row（拿到最新 tgt_text + override）
    const fresh = SegmentRepo.getRow(segId)!
    const tgtText = fresh.tgt_text_edited ?? fresh.tgt_text
    if (!tgtText) throw new Error('该 segment 没有译文，不能合成')

    // 找 character 与 voice
    const character = fresh.character_id
      ? CharacterRepo.get(asCharacterId(fresh.character_id))
      : null
    const ov = SegmentRepo.getOverrides(segId) as any
    const effEmotion = ov.userEmotion ?? fresh.emotion ?? null
    const voiceId =
      ov.userVoiceId ??
      character?.voiceId ??
      'female-shaonv' // 极端兜底

    // 复用 tts-stage 的 tuning 逻辑（这里手写一份精简版，避免循环依赖）
    const tuning = pickTuning(effEmotion)
    const intensity = ov.userIntensity ?? tuning.intensity
    const speed = ov.userSpeed ?? tuning.speed
    // v0.4.11 vol override：用户在工作台填了就用，否则走 emotion tuning 默认值
    const vol = ov.userVol ?? tuning.vol
    const enrichedText = enrichPauses(tgtText, effEmotion)

    logger.info({ segId, voiceId, effEmotion, intensity, speed, vol }, '单 segment 重合成')

    const tts = providers().tts
    const ttsInput: TtsInput = {
      model: project.config.tts.model,
      text: enrichedText,
      voiceId,
      format: 'mp3',
      sampleRate: 32_000,
      emotion: effEmotion ?? undefined,
      emotionIntensity: intensity,
      speed,
      vol,
      pitch: tuning.pitch,
    }
    const out = await tts.synthesize(ttsInput)
    // 把新 TTS 文件覆盖
    const projectDir = getProjectDir(projectId)
    const dst = join(projectDir, 'tts', `${segId}.mp3`)
    await mkdir(join(projectDir, 'tts'), { recursive: true })
    const { rename, copyFile, unlink } = await import('node:fs/promises')
    try {
      await unlink(dst).catch(() => {})
      await rename(out.audioPath, dst)
    } catch {
      await copyFile(out.audioPath, dst)
      await unlink(out.audioPath).catch(() => {})
    }
    db()
      .prepare(`UPDATE segments SET tgt_audio_path = ?, tgt_dur_ms = ? WHERE id = ?`)
      .run(dst, out.durationMs, segId)
    // ★ v0.4.12 修复：setTtsSnapshot 必须记录"本次实际合成用的 vol/pitch"，否则：
    //   1. 工作台 UI 显示的"实际合成参数"和真实合成参数不一致
    //   2. align-stage / segment:assets 重读 tts_vol/tts_pitch 时拿到的是默认值
    SegmentRepo.setTtsSnapshot(segId, {
      inputText: enrichedText,
      voiceId,
      emotion: effEmotion,
      intensity,
      speed,
      vol,                  // ★ 实际合成用的 vol（含 userVol override）
      pitch: tuning.pitch,
    })
    return { ok: true, newDurMs: out.durationMs }
  })
}

// ─── 重合成用的 tuning（独立一份避免依赖 tts-stage） ──────────────
interface Tuning {
  intensity: number
  speed: number
  vol: number
  pitch: number
}
const TUNING: Record<string, Tuning> = {
  angry: { intensity: 1.4, speed: 1.03, vol: 1.1, pitch: 1 },
  happy: { intensity: 1.3, speed: 1.03, vol: 1.05, pitch: 1 },
  sad: { intensity: 1.3, speed: 0.95, vol: 0.9, pitch: -1 },
  surprised: { intensity: 1.4, speed: 1.05, vol: 1.05, pitch: 1 },
  fearful: { intensity: 1.3, speed: 1.03, vol: 0.95, pitch: 0 },
  disgusted: { intensity: 1.3, speed: 0.98, vol: 1.0, pitch: 0 },
  neutral: { intensity: 1.0, speed: 1.0, vol: 1.0, pitch: 0 },
}
const pickTuning = (raw: string | null | undefined): Tuning => {
  if (!raw) return TUNING.neutral!
  const k = raw.trim().toLowerCase()
  const m =
    k === 'surprise' ? 'surprised' :
    k === 'fear' ? 'fearful' :
    k === 'disgust' ? 'disgusted' :
    k
  return TUNING[m] ?? TUNING.neutral!
}
const enrichPauses = (text: string, emotion: string | null | undefined): string => {
  if (!text) return text
  const e = (emotion ?? '').trim().toLowerCase()
  if (/<#\d/.test(text)) return text
  let hard = 0
  if (e === 'sad') hard = 0.15
  else if (e === 'surprised' || e === 'surprise') hard = 0.15
  if (hard === 0) return text
  let added = false
  return text.replace(/([。！？!?])(?=\s*\S)/g, (m) => {
    if (added) return m
    added = true
    return `${m}<#${hard.toFixed(2)}#>`
  })
}

// ─────────────────────────────────────────────────────────────────
// v0.4.22 惰性补 samplePath：
// 旧项目跑完 voice-clone 时门槛 2500ms 卡掉了短样本角色，
// 现在 drawer 打开任一 segment 都自动拼接 → stream_loop → 写 samplePath。
// 只生成"可播放/可展示"的本地样本文件，不调 MiniMax clone（character 已经有 system voice 兜底）。
// 用户想真克隆出新 voice_id 可以走「使用原音」按钮逐句兜底，或重跑 voice-clone stage。
// ─────────────────────────────────────────────────────────────────

const MIN_SAMPLE_UPLOAD_MS = 10_500

const lazyBuildCharacterSampleMemo = new Map<string, Promise<string | null>>()

async function lazyBuildCharacterSample(
  characterId: ReturnType<typeof asCharacterId>,
  projectId: any,
  projectDir: string,
): Promise<string | null> {
  // 进程内去重：同一个 character 同时多个 drawer 请求 → 一次 ffmpeg
  const key = `${projectId}:${characterId}`
  if (lazyBuildCharacterSampleMemo.has(key)) return lazyBuildCharacterSampleMemo.get(key)!
  const p = doLazyBuildCharacterSample(characterId, projectId, projectDir)
  lazyBuildCharacterSampleMemo.set(key, p)
  // 完成后清缓存（让下一次刷新还能再跑——比如用户删了文件）
  void p.finally(() => lazyBuildCharacterSampleMemo.delete(key))
  return p
}

async function doLazyBuildCharacterSample(
  characterId: ReturnType<typeof asCharacterId>,
  projectId: any,
  projectDir: string,
): Promise<string | null> {
  const segs = SegmentRepo.list(projectId).filter(
    (s) => s.characterId === characterId && s.srcAudioPath && existsSync(s.srcAudioPath!),
  )
  if (segs.length === 0) return null

  const voicesDir = join(projectDir, 'voices')
  await mkdir(voicesDir, { recursive: true })
  const samplePath = join(voicesDir, `${characterId}-sample.mp3`)
  if (existsSync(samplePath)) {
    // 文件已在磁盘，只是 DB 字段没写——补写一次就够
    CharacterRepo.setSample(characterId, samplePath)
    return samplePath
  }

  const listPath = join(voicesDir, `${characterId}-concat-list.txt`)
  await (await import('node:fs/promises')).writeFile(
    listPath,
    segs.map((s) => `file '${s.srcAudioPath!.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    'utf8',
  )
  const ffmpeg = requireFfmpeg()
  const concatTmp = join(voicesDir, `${characterId}-concat-tmp.wav`)
  let r = await runCmd(ffmpeg, [
    '-y', '-f', 'concat', '-safe', '0',
    '-i', listPath, '-c', 'copy', concatTmp,
  ])
  if (r.code !== 0 || !existsSync(concatTmp)) {
    logger.warn({ characterId, stderr: r.stderr.slice(-200) }, '惰性拼接失败')
    return null
  }
  // stream_loop 无缝循环到 10.5s+（短样本兜底；够长会被 -t 截断）
  r = await runCmd(ffmpeg, [
    '-stream_loop', '-1',
    '-i', concatTmp,
    '-t', String(MIN_SAMPLE_UPLOAD_MS / 1000),
    '-c:a', 'libmp3lame', '-b:a', '128k',
    '-ar', '32000', '-ac', '1',
    '-y', samplePath,
  ])
  if (r.code !== 0 || !existsSync(samplePath)) {
    logger.warn({ characterId, stderr: r.stderr.slice(-200) }, '惰性 stream_loop 失败')
    return null
  }
  CharacterRepo.setSample(characterId, samplePath)
  logger.info({ characterId, samplePath, srcCount: segs.length }, '惰性补 samplePath 成功')
  return samplePath
}
