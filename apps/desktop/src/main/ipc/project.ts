import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { handle, type IpcContext } from './index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { StageRepo } from '../storage/stage-repo.js'
import { getProjectDir } from '../orchestrator/index.js'
import { registerSourcePreview, toProjectAssetUrl } from '../index.js'
import { logger } from '../logger.js'
import type { OriginalAudioRange } from '@dramaprime/core-types'

export const registerProjectIpc = (_ctx: IpcContext): void => {
  handle('project:create', async (input) => ProjectRepo.create(input))
  handle('project:list', async (filter) => ProjectRepo.list(filter))
  handle('project:get', async (id) => ProjectRepo.get(id))
  // v0.4.12 删除项目：DB + 磁盘目录一起清
  // 源视频不在项目目录里，删除项目不影响源文件
  handle('project:delete', async (id) => {
    ProjectRepo.delete(id)
    try {
      await rm(getProjectDir(id), { recursive: true, force: true })
    } catch {
      /* 目录可能本来就不存在，忽略 */
    }
  })
  handle('project:duplicate', async (_id) => {
    throw new Error('project:duplicate 待实现（v0.1 stub）')
  })
  handle('project:import', async (_path) => {
    throw new Error('project:import 待实现（v0.1 stub）')
  })
  handle('project:export', async (_input) => {
    throw new Error('project:export 待实现（v0.1 stub）')
  })

  // v0.5 保留原音范围 —— 落库 + 失效相关 stage
  handle('project:set-original-audio-ranges', async ({ id, ranges }) => {
    const normalized = normalizeRanges(ranges)
    ProjectRepo.setOriginalAudioRanges(id, normalized)
    // range 只影响音轨拼接与字幕生成，前面的 ASR / 翻译 / TTS / align 都不用重跑
    StageRepo.reset(id, 'subtitle-burn')
    StageRepo.reset(id, 'mix-render')
    logger.info(
      { projectId: id, count: normalized.length },
      'originalAudioRanges updated, invalidated subtitle-burn + mix-render',
    )
  })

  // v0.5 让 renderer 播源视频：把源视频路径加入 app:// 白名单，返回可播 URL
  handle('project:register-source-preview', async ({ id }) => {
    const project = ProjectRepo.get(id)
    if (!project.sourcePath) throw new Error('project has no sourcePath')
    const url = registerSourcePreview(project.sourcePath)
    return { url }
  })

  // v0.5 读 preprocess/metadata.json + 缩略图 URL —— 预处理 tab 一次拿全
  handle('project:get-preprocess-meta', async ({ id }) => {
    const preDir = join(getProjectDir(id), 'preprocess')
    const metaPath = join(preDir, 'metadata.json')
    if (!existsSync(metaPath)) return null
    try {
      const raw = await readFile(metaPath, 'utf-8')
      const parsed = JSON.parse(raw) as {
        fps?: number
        width?: number
        height?: number
        durationMs?: number
      }
      // 5 张缩略图，与 ffmpeg-stages.ts:158 命名规则对齐（01-05.jpg）
      // 走 app:// 协议 —— userData/projects 已在白名单
      const thumbsDir = join(preDir, 'thumbs')
      const thumbnails: string[] = []
      for (let i = 1; i <= 5; i++) {
        const name = String(i).padStart(2, '0') + '.jpg'
        const p = join(thumbsDir, name)
        if (existsSync(p)) thumbnails.push(toProjectAssetUrl(p))
      }
      return {
        fps: parsed.fps ?? 0,
        width: parsed.width ?? 0,
        height: parsed.height ?? 0,
        durationMs: parsed.durationMs ?? 0,
        thumbnails,
      }
    } catch (err) {
      logger.warn({ err: String(err), metaPath }, 'get-preprocess-meta 解析失败')
      return null
    }
  })
}

/**
 * v0.5 传入的 range 数组做规范化：
 *   1. 过滤 startMs >= endMs 的脏数据
 *   2. 按 startMs 升序排序
 *   3. 合并重叠或相邻（间隔 < 100ms）的段
 *
 * 返回值直接落库，UI 就不用维护"合并/排序"逻辑，避免边界 bug。
 */
const normalizeRanges = (raw: OriginalAudioRange[]): OriginalAudioRange[] => {
  const valid = raw.filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs)
  const merged: OriginalAudioRange[] = []
  for (const r of valid) {
    const last = merged[merged.length - 1]
    if (last && r.startMs <= last.endMs + 100) {
      last.endMs = Math.max(last.endMs, r.endMs)
      if (r.note && !last.note) last.note = r.note
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}
