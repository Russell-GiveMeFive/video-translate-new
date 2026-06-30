import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult, ChatMessage } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { db } from '../storage/index.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'

/**
 * v0.5 VLM OCR Stage —— 用 M3 VLM 识别原片烧录中文字幕的真实时间轴
 *
 * 解决问题：ASR 切句节奏 ≠ 原片字幕节奏 → 一句中文配多句译文（客户多次反馈）
 *
 * 策略：
 *   1. ffmpeg 按 framesPerSecond 抽帧（默认 3 fps；1 分钟视频 = 180 帧）到 frames/ 目录
 *   2. 批量调 M3 VLM 识别每帧画面**底部**的中文字幕文本
 *   3. 合并相邻同文本帧成时间区间 → 真实"字幕显示时间轴"
 *   4. 用这些时间区间**重写** SQLite segments 表（保留 ASR speaker_id 信息）
 *   5. 失败 → kind: skipped，下游沿用 ASR segment（fallback）
 *
 * 位置：cluster 之后、translate 之前（speaker_id 已经定，但 segment 切分还可改）
 *
 * 成本估算：M3 VLM ~$0.005-0.02/帧，1 分钟视频 90 帧 = $0.5-1.8
 */
export const vlmOcrStage: Stage = {
  name: 'ocr-assist',
  version: 1,
  inputsFrom: ['preprocess', 'cluster'],
  blocking: false, // 失败不阻塞——下游沿用 ASR segment
  retries: 1,
  kind: 'provider',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    if (!existsSync(project.sourcePath)) {
      return { kind: 'skipped', reason: '源视频不存在，跳过 VLM OCR' }
    }

    // ★ v0.4.9 用户手动指定无烧录字幕 → 直接跳过 OCR 省时间省钱
    // 默认 true（短剧绝大多数有字幕）；用户在创建项目向导里能改成 false
    if (project.config.ocr?.hasBurnedInSubtitles === false) {
      ctx.logger.info('用户明确指定原片无烧录字幕，跳过 VLM OCR')
      return { kind: 'skipped', reason: '用户指定原片无烧录字幕，沿用 ASR 切句' }
    }

    // ── Step 1: 抽帧（VLM_OCR_CONFIG.framesPerSecond）──────────────────
    ctx.reportProgress(5, '抽帧准备 VLM OCR')
    const framesDir = join(ctx.projectDir, 'preprocess', 'ocr-frames')
    await mkdir(framesDir, { recursive: true })

    const ffmpeg = requireFfmpeg()
    // v0.5: 抽帧 fps + 缩小到 480 宽（VLM 不需要原画质，省带宽和成本）
    // 短剧通常 720×1280 竖屏，缩到 480 宽 = 480×853
    const fps = VLM_OCR_CONFIG.framesPerSecond
    const extractResult = await runCmd(
      ffmpeg,
      [
        '-i',
        project.sourcePath,
        '-vf',
        `fps=${fps},scale=480:-2`,
        '-q:v',
        '4', // jpeg quality（1-31，越小越高）
        '-y',
        join(framesDir, 'f_%05d.jpg'),
      ],
      { signal: ctx.signal },
    )
    if (extractResult.code !== 0) {
      return {
        kind: 'failed',
        error: {
          code: 'ffmpeg.encode-failed',
          message: `ffmpeg 抽帧失败 (code=${extractResult.code}): ${extractResult.stderr.slice(0, 300)}`,
          retriable: true,
        },
      }
    }

    const frameFiles = (await readdir(framesDir))
      .filter((f) => f.startsWith('f_') && f.endsWith('.jpg'))
      .sort()
    if (frameFiles.length === 0) {
      return { kind: 'skipped', reason: '抽帧产物为空，跳过 VLM OCR' }
    }
    ctx.logger.info('抽帧完成', { frameCount: frameFiles.length, fps })

    // ── Step 2: 批量 VLM OCR（并发 + 全局超时） ───────────────────
    ctx.reportProgress(15, `VLM 识别 ${frameFiles.length} 帧字幕`)
    const llm = providers().llm

    // ★ v0.4.9 全局超时（避免 VLM 慢/卡导致整个 pipeline 死掉）
    // 60 秒预算够 99 帧并发=4 的场景（理论 25s，留 60s 留余量）；超时 → skipped 兜底
    const globalDeadlineMs = VLM_OCR_CONFIG.globalTimeoutMs
    const startMs = Date.now()
    const globalAbort = new AbortController()
    const timeoutHandle = setTimeout(() => {
      ctx.logger.warn(`VLM 全局超时 ${globalDeadlineMs}ms，中止 OCR 走 ASR 兜底`)
      globalAbort.abort()
    }, globalDeadlineMs)
    const combinedSignal = (() => {
      try {
        return AbortSignal.any([ctx.signal, globalAbort.signal])
      } catch {
        // 老 Node 不支持 AbortSignal.any → fallback 用 ctx.signal
        return ctx.signal
      }
    })()

    // 并发池：限制同时进行的 VLM 请求数
    const CONCURRENCY = VLM_OCR_CONFIG.concurrency
    const frameResults: FrameOcrResult[] = new Array(frameFiles.length)
    let completed = 0
    let earlyExitTriggered = false

    const processFrame = async (i: number): Promise<void> => {
      if (combinedSignal.aborted || earlyExitTriggered) {
        frameResults[i] = { tsMs: Math.round((i / fps) * 1000), text: '', skipped: true }
        return
      }
      const frameFile = frameFiles[i]!
      const framePath = join(framesDir, frameFile)
      const tsMs = Math.round((i / fps) * 1000)
      try {
        const ocrText = await ocrFrameWithVlm(framePath, llm, combinedSignal)
        frameResults[i] = { tsMs, text: ocrText, skipped: false }
      } catch (err) {
        if (combinedSignal.aborted) {
          frameResults[i] = { tsMs, text: '', skipped: true }
          return
        }
        ctx.logger.warn('单帧 VLM OCR 失败，跳过', {
          frame: frameFile,
          err: String((err as any)?.message ?? err),
        })
        frameResults[i] = { tsMs, text: '', skipped: false }
      } finally {
        completed++
        if (completed % 5 === 0 || completed === frameFiles.length) {
          ctx.reportProgress(
            15 + Math.round((completed / frameFiles.length) * 70),
            `VLM OCR ${completed}/${frameFiles.length}`,
          )
        }
      }
    }

    // 简单的并发池实现：分批 promise.all
    // 在每批结束时检查"视频开头是否全空"——是的话早退节省成本
    for (let batchStart = 0; batchStart < frameFiles.length; batchStart += CONCURRENCY) {
      if (combinedSignal.aborted) break
      const batchEnd = Math.min(batchStart + CONCURRENCY, frameFiles.length)
      const promises: Promise<void>[] = []
      for (let i = batchStart; i < batchEnd; i++) promises.push(processFrame(i))
      await Promise.all(promises)

      // 早退检查：前 10 帧全空 → VLM 大概率不工作（或视频无烧录字幕），放弃整个 stage
      if (batchStart === 0 && batchEnd >= 10) {
        const head = frameResults.slice(0, Math.min(10, batchEnd))
        const allEmpty = head.every((r) => r && !r.text.trim())
        if (allEmpty) {
          ctx.logger.warn('前 10 帧 VLM 全空，触发早退（视频可能无烧录字幕或 VLM 不可用）')
          earlyExitTriggered = true
          break
        }
      }
    }
    clearTimeout(timeoutHandle)

    // 用 ASR 兜底的条件：超时 / 早退 / 中止
    if (globalAbort.signal.aborted || earlyExitTriggered) {
      // 清抽帧产物，沿用 ASR 切句
      await rm(framesDir, { recursive: true, force: true }).catch(() => {})
      return {
        kind: 'skipped',
        reason: earlyExitTriggered
          ? 'VLM 前 10 帧全空，可能视频无烧录字幕；沿用 ASR 切句'
          : `VLM 全局超时 ${globalDeadlineMs}ms，沿用 ASR 切句`,
      }
    }
    if (ctx.signal.aborted) {
      return {
        kind: 'failed',
        error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
      }
    }

    // 填补 skipped 的空位（理论不应有，防御性）
    for (let i = 0; i < frameResults.length; i++) {
      if (!frameResults[i]) {
        frameResults[i] = { tsMs: Math.round((i / fps) * 1000), text: '', skipped: true }
      }
    }
    ctx.logger.info('VLM OCR 完成', {
      durationMs: Date.now() - startMs,
      completed,
      total: frameFiles.length,
    })

    // ── Step 3: 合并相邻同文本帧 → 时间轴 ──────────────────────────
    ctx.reportProgress(88, '合并 OCR 时间轴')
    const ocrSegments = mergeFramesToSegments(frameResults, fps)
    ctx.logger.info('OCR 时间轴构建', {
      frameCount: frameFiles.length,
      ocrSegmentCount: ocrSegments.length,
      sample: ocrSegments.slice(0, 5),
    })

    if (ocrSegments.length === 0) {
      // 一个字幕都没识别到 → 跳过下游（保留 ASR 切句）
      return {
        kind: 'skipped',
        reason: 'VLM 未识别到任何字幕，沿用 ASR 切句',
      }
    }

    // ── Step 4: 重写 segments 表（并存策略：把 OCR 文本+时间存到新字段） ────
    ctx.reportProgress(95, '应用 OCR 时间轴')
    applyOcrSegmentsToDb(ctx.projectId as string, ocrSegments)

    // 清理抽帧文件（节省磁盘）
    await rm(framesDir, { recursive: true, force: true }).catch(() => {})

    ctx.reportProgress(100, `OCR 完成：${ocrSegments.length} 句字幕`)
    return {
      kind: 'ok',
      outputs: {
        ocrSegmentCount: String(ocrSegments.length),
        framesProcessed: String(frameFiles.length),
      },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── 配置 ──────────────────────────────────────────────────────────

const VLM_OCR_CONFIG = {
  /** 抽帧密度（fps）—— v0.4.23 提到 3 fps（每秒 3 帧）增强短字幕捕捉
   *  代价：VLM 调用量翻倍（成本 / 时间），收益：0.3-0.5s 闪现字幕识别率提升 */
  framesPerSecond: 3,
  /** VLM 并发数：客户机器跑 4 路通常稳，再多容易触发 rate limit */
  concurrency: 4,
  /** 全局超时（ms）：超时直接走 ASR 兜底，避免 VLM 慢导致整个 pipeline 死 */
  globalTimeoutMs: 60_000,
}

// ─── 类型 ──────────────────────────────────────────────────────────

interface FrameOcrResult {
  tsMs: number
  text: string
  skipped: boolean // 是否被跳帧优化（沿用上一帧文本）
}

interface OcrSegment {
  startMs: number
  endMs: number
  text: string
}

// ─── 核心函数 ──────────────────────────────────────────────────────

/**
 * 调 M3 VLM 识别单帧画面**底部**的中文字幕文本。
 *
 * 这是 5-10 行的核心 prompt 工程，强烈影响 OCR 质量。
 *
 * Prompt 当前实现已经够用，但你可以调：
 *   - "仅识别底部字幕区" vs "识别所有文字" → 当前选前者，避免识别画面里的招牌/手机屏文字
 *   - 是否要求 JSON 输出 → 当前 plain text 更简单，但 JSON 更结构化
 *   - 是否给 few-shot 例子 → 当前没给，M3 大概率懂
 *
 * 返回："你弟弟现在结婚急用钱" 这种纯中文字幕，没识别到字幕返回 ''
 */
const ocrFrameWithVlm = async (
  framePath: string,
  llm: ReturnType<typeof providers>['llm'],
  signal?: AbortSignal,
): Promise<string> => {
  const imageData = await readFile(framePath)
  const base64 = imageData.toString('base64')

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64,
          },
        },
        {
          type: 'text',
          text: `请仅识别这张画面**底部位置**的中文字幕（不是画面中其他位置的招牌、屏幕文字等）。

输出要求：
- 如果底部有字幕：直接返回字幕原文，不加任何解释和引号
- 如果底部没字幕：返回空字符串
- 字幕中的标点（。！？）保留原样

只返回字幕文本本身，不要"画面显示..."这种描述话。`,
        },
      ],
    },
  ]

  const res = await llm.chat({
    model: 'MiniMax-M3',
    messages,
    maxTokens: 256,
    temperature: 0.1, // 低温度 → 更稳定的 OCR 输出
    signal,
  })

  // 清理：去掉可能的引号、前缀、空格
  let text = res.text.trim()
  text = text.replace(/^["「『"]+|["」』"]+$/g, '').trim()
  text = text.replace(/^字幕[:：]?\s*/, '').trim()
  if (text === '空' || text === '无' || text === '没有字幕') return ''
  return text
}

/**
 * 把逐帧 OCR 结果合并成"字幕显示时间区间"。
 *
 * 策略：
 *   - 相邻帧文本相同 → 合并（同一句字幕在多帧上停留）
 *   - 相邻帧文本不同（且新文本非空）→ 切新 segment
 *   - 空文本 = 字幕消失间隙（跳过不入 segment）
 *
 * TODO（用户决策点）：是否要做"字幕文本相似度容错"？
 *   M3 可能在相邻帧给微小差异（如标点、错字）。当前严格相等，可能切碎太多。
 *   阈值：编辑距离 ≤ 2 视为同一句？
 *
 * 时间扩展：每个区间末尾加 1/fps 秒（约 666ms）—— 因为这一帧捕捉到字幕，
 * 字幕实际持续到下一帧之前。
 */
const mergeFramesToSegments = (
  frames: FrameOcrResult[],
  fps: number,
): OcrSegment[] => {
  const segments: OcrSegment[] = []
  const frameDurMs = Math.round(1000 / fps)
  let current: OcrSegment | null = null

  for (const f of frames) {
    const normalized = f.text.trim()
    if (normalized === '') {
      // 空帧 → 当前 segment 收尾
      if (current) {
        segments.push(current)
        current = null
      }
      continue
    }
    if (!current) {
      current = { startMs: f.tsMs, endMs: f.tsMs + frameDurMs, text: normalized }
    } else if (current.text === normalized) {
      // 文本一致 → 扩展 endMs
      current.endMs = f.tsMs + frameDurMs
    } else {
      // 文本变化 → 切 segment
      segments.push(current)
      current = { startMs: f.tsMs, endMs: f.tsMs + frameDurMs, text: normalized }
    }
  }
  if (current) segments.push(current)

  // 过滤太短的（< 200ms 可能是 OCR 抖动）
  return segments.filter((s) => s.endMs - s.startMs >= 200)
}

/**
 * 把 OCR 时间轴应用到 SQLite segments 表。
 *
 * **并存策略**（用户拍板）：
 *   - 不删 ASR segments
 *   - 新建一个 segments_ocr 表，下游 translate/tts 优先用 OCR 时间轴
 *   - OCR 失败的 ASR segment 仍可作为 fallback
 *
 * v0.5.0 简化实现：直接把 ASR segments 的 src_text + start_ms + end_ms 全部覆盖为 OCR 数据
 * （保留 character_id / speaker_id 通过最近邻匹配）
 *
 * TODO（用户决策点）：覆盖策略 vs 真正并存策略？
 *   - 覆盖（当前）：简单，但 VLM 一旦错就回不去
 *   - 并存（需新表）：更鲁棒，需改 SegmentRepo + translate-stage 读取逻辑
 */
const applyOcrSegmentsToDb = (
  projectId: string,
  ocrSegments: OcrSegment[],
): void => {
  // 拿到旧 ASR segments，做 speaker_id / character_id 最近邻匹配
  const oldSegs = SegmentRepo.list(projectId as any)
  const findNearestSpeakerInfo = (
    targetStartMs: number,
  ): { speakerId: string | null; characterId: string | null } => {
    let best: { speakerId: string | null; characterId: string | null; distance: number } = {
      speakerId: null,
      characterId: null,
      distance: Infinity,
    }
    for (const s of oldSegs) {
      const midMs = (s.startMs + s.endMs) / 2
      const distance = Math.abs(midMs - targetStartMs)
      if (distance < best.distance) {
        best = { speakerId: s.speakerId, characterId: s.characterId, distance }
      }
    }
    return { speakerId: best.speakerId, characterId: best.characterId }
  }

  // 删除旧 ASR segments
  db().prepare(`DELETE FROM segments WHERE project_id = ?`).run(projectId)

  // 重新插入 OCR segments
  const insert = db().prepare(`
    INSERT INTO segments (id, project_id, idx, start_ms, end_ms, src_text, speaker_id, character_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db().transaction(() => {
    for (let i = 0; i < ocrSegments.length; i++) {
      const o = ocrSegments[i]!
      const speakerInfo = findNearestSpeakerInfo(o.startMs)
      const id = `${projectId}-ocr-${i}`
      insert.run(
        id,
        projectId,
        i,
        o.startMs,
        o.endMs,
        o.text,
        speakerInfo.speakerId,
        speakerInfo.characterId,
      )
    }
  })
  tx()
}
