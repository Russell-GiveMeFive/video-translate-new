/**
 * "复制并复刻" 核心逻辑（v0.4.16 引入，v0.4.20 重写）
 *
 * 行为：优先取角色已有的 samplePath（voice-clone-stage 拼好的基础样本），
 *      用 stream_loop 无缝循环到 10.5s+，再 upload + clone。
 *      没有 samplePath 时回退到 srcAudioPath concat（旧路径）。
 *
 * 为什么优先用 samplePath？
 *   - voice-clone-stage 已经做过"按 segment 时间戳精确裁切 + 无缝拼接"了
 *   - 直接基于它循环 = 一次 ffmpeg，干净；无需重新读 segments、写 concat list
 *   - 跟用户在 UI「克隆样本」播放器听到的是同一段音频，行为可预期
 *
 * 调用点：
 *   1. IPC `character:reclone-extended`（UI 按钮已下线，保留作回归入口）
 *   2. voice-clone-stage 内部 skipped/failed 自动 fallback
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  asCharacterId,
  asProjectId,
  type CharacterId,
  type ProjectId,
} from '@dramaprime/core-types'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'
import { providers } from '../providers/index.js'
import { CharacterRepo, ProjectRepo } from '../storage/index.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { VoiceAssetRepo } from '../storage/voice-asset-repo.js'
import { getProjectDir } from './index.js'
import { logger } from '../logger.js'

export interface RecloneExtendedResult {
  ok: true
  samplePath: string
  sourceCount: number
  voiceId: string
  voiceExpiresAt: number | null
}

/** MiniMax voice_clone API 要求 sample > 10s；留 500ms 余量 */
const MIN_SAMPLE_MS = 10_500

export async function recloneExtended(
  characterId: CharacterId | string,
  projectId: ProjectId | string,
): Promise<RecloneExtendedResult> {
  const cid = asCharacterId(characterId)
  const pid = asProjectId(projectId)

  const project = ProjectRepo.get(pid)
  if (!project) {
    throw new Error(`项目 ${projectId} 不存在`)
  }
  const projectDir = getProjectDir(pid)
  const voicesDir = join(projectDir, 'voices')
  const extendedSample = join(voicesDir, `${cid}-extended-sample.wav`)
  const ffmpeg = requireFfmpeg()

  const character = CharacterRepo.get(cid)
  const baseSamplePath = character?.samplePath
  let sourceCount = 0

  if (baseSamplePath && existsSync(baseSamplePath)) {
    // ── 路径 A（首选）：已有 samplePath → 直接 stream_loop 循环到 10.5s+ ──
    logger.info({ characterId: cid, baseSamplePath }, '复用已有 samplePath 循环复制')
    sourceCount = 1
    const r = await runCmd(ffmpeg, [
      '-stream_loop', '-1',
      '-i', baseSamplePath,
      '-t', String(MIN_SAMPLE_MS / 1000),
      '-c:a', 'pcm_s16le',
      '-ar', '32000',
      '-ac', '1',
      '-y',
      extendedSample,
    ])
    if (r.code !== 0 || !existsSync(extendedSample)) {
      throw new Error(`ffmpeg stream_loop 失败 code=${r.code}：${r.stderr.slice(-500)}`)
    }
  } else {
    // ── 路径 B（兜底）：没有 samplePath → 从 srcAudioPath concat 再循环 ──
    logger.info({ characterId: cid }, '无 samplePath，回退到 srcAudioPath concat')
    const segs = SegmentRepo.list(pid).filter(
      (s) => s.characterId === cid && s.startMs != null,
    )
    if (segs.length === 0) {
      throw new Error('该角色没有 segments，无法拼接')
    }
    const validSegs = segs.filter((s) => s.srcAudioPath && existsSync(s.srcAudioPath))
    if (validSegs.length === 0) {
      throw new Error('该角色所有 segments 都没有 src_audio_path 文件（请先跑 demix + asr-diarize）')
    }
    sourceCount = validSegs.length
    const listPath = join(voicesDir, `${cid}-concat-list.txt`)
    await writeFile(
      listPath,
      validSegs
        .map((s) => `file '${s.srcAudioPath!.replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n',
      'utf8',
    )
    const concatOut = join(voicesDir, `${cid}-concat-tmp.wav`)
    let r = await runCmd(ffmpeg, [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      concatOut,
    ])
    if (r.code !== 0 || !existsSync(concatOut)) {
      throw new Error(`ffmpeg 拼接失败 code=${r.code}：${r.stderr.slice(-500)}`)
    }
    // 无缝 stream_loop 到 10.5s+（不管原长度，统一截到 10.5s）
    r = await runCmd(ffmpeg, [
      '-stream_loop', '-1',
      '-i', concatOut,
      '-t', String(MIN_SAMPLE_MS / 1000),
      '-c:a', 'pcm_s16le',
      '-ar', '32000',
      '-ac', '1',
      '-y',
      extendedSample,
    ])
    if (r.code !== 0 || !existsSync(extendedSample)) {
      throw new Error(`ffmpeg stream_loop 失败 code=${r.code}：${r.stderr.slice(-500)}`)
    }
  }

  // 写 sample_path（即使复刻失败也保留拼接结果，下次重试直接用）
  CharacterRepo.setSample(cid, extendedSample)
  CharacterRepo.setUseOriginalAudio(cid, false)

  // upload + clone
  const clone = providers().clone
  const up = await clone.upload(extendedSample)
  const cloned = await clone.clone({
    fileId: up.fileId,
    model: project.config.tts.model,
  })
  CharacterRepo.setVoice(cid, {
    voiceId: cloned.voiceId,
    voiceStatus: 'temp',
    voiceExpiresAt: cloned.expiresAt,
  })

  // 跨项目音色库
  const characterAfter = CharacterRepo.get(cid)
  if (characterAfter) {
    VoiceAssetRepo.record({
      voiceId: cloned.voiceId as any,
      defaultName: characterAfter.name ?? '未命名角色',
      originProjectId: pid,
      originCharacterName: characterAfter.name ?? '未命名角色',
    })
  }

  return {
    ok: true,
    samplePath: extendedSample,
    sourceCount,
    voiceId: cloned.voiceId,
    voiceExpiresAt: cloned.expiresAt,
  }
}
