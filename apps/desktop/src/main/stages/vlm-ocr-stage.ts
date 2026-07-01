import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult, ChatMessage, ChatInput } from '@dramaprime/core-types'
import { isAppError } from '@dramaprime/core-types'
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
    // ★ v0.5 全局禁用 VLM OCR
    //
    // 决策原因（写给未来想重新启用的人）：
    //   - M3 VLM 对"画面文字 vs 字幕"区分能力不稳定，会把招牌/手机屏/品牌 logo
    //     等也识别为字幕，污染时间轴；强化 prompt + post-filter 后仍不够干净
    //   - VLM OCR 翻车时本就走 ASR 兜底，干脆默认全 ASR 更稳
    //   - 调用成本 + 1026 内容审核拒绝在短剧场景命中率较高，性价比拉胯
    //
    // 保留的设计资产（重启时直接放开下面 return 即可恢复）：
    //   - prompt 工程：字幕判定特征 + 9 类反例（vlm-ocr-stage.ts:340-380）
    //   - 1026 内容审核处理 + 阈值早退
    //   - trace 日志（requestId / 耗时 / sensitiveContentIndex）
    //   - hasBurnedInSubtitles flag 仍在 domain.ts，未来想按视频属性条件启用
    //
    // 保留 stage 名称"OCR 辅助"在 pipeline UI 上作为占位，给用户视觉一致性。
    ctx.logger.info('VLM OCR 已全局禁用，沿用 ASR 切句（v0.5 决策）')
    return { kind: 'skipped', reason: 'VLM OCR 已禁用，沿用 ASR 切句' }

    // ─── 以下代码保留但不执行；将来想启用 OCR 时删掉上面 return 即可 ───
    // eslint-disable-next-line no-unreachable
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

    // ★ v0.5 用户偏好 ASR 兜底策略 → 跳过 VLM OCR
    // 跟 hasBurnedInSubtitles 是独立维度：前者是"视频有没有字幕"，这里是"想不想跑 VLM"
    // 用户场景：赶时间 / 省成本 / 上次 VLM 翻车想换个策略试试
    if (project.config.ocr?.strategy === 'asr') {
      ctx.logger.info('用户选择 ASR 策略，跳过 VLM OCR')
      return { kind: 'skipped', reason: '用户选择 ASR 策略，沿用 ASR 切句' }
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
    // v0.5 敏感内容计数（1026 / new_sensitive）：累计达阈值整 stage 早退
    // 短剧场景如果命中大量敏感画面，继续跑只是浪费 60s 预算
    let sensitiveCount = 0
    const SENSITIVE_ABORT_THRESHOLD = 10 // 累计 ≥10 帧敏感 → 早退
    const SENSITIVE_RATIO_THRESHOLD = 0.4 // 或者 已处理帧中 ≥40% 敏感 → 早退（前提至少 5 帧）

    const processFrame = async (i: number): Promise<void> => {
      if (combinedSignal.aborted || earlyExitTriggered) {
        frameResults[i] = { tsMs: Math.round((i / fps) * 1000), text: '', skipped: true }
        return
      }
      const frameFile = frameFiles[i]!
      const framePath = join(framesDir, frameFile)
      const tsMs = Math.round((i / fps) * 1000)
      // v0.5 trace 钩子：每次 M3 调用的 start/end 都打日志，含 requestId/url/耗时
      // 全量打（用户 A 方案），让 60s 内究竟有没有调 M3 一目了然
      const traceLogger: ChatInput['traceLogger'] = (ev) => {
        const fn = ev.level === 'error' ? ctx.logger.error : ev.level === 'warn' ? ctx.logger.warn : ctx.logger.info
        fn.call(ctx.logger, `M3 ${ev.kind}`, { ...ev, frame: frameFile, frameIdx: i })
      }
      try {
        const ocrText = await ocrFrameWithVlm(framePath, llm, combinedSignal, traceLogger)
        frameResults[i] = { tsMs, text: ocrText, skipped: false }
      } catch (err) {
        if (combinedSignal.aborted) {
          frameResults[i] = { tsMs, text: '', skipped: true }
          return
        }
        // v0.5 区分 1026 内容审核拒绝：这是永久错误，不应该再重试，也别污染普通失败日志
        if (isAppError(err) && err.code === 'provider.content-sensitive') {
          sensitiveCount++
          frameResults[i] = { tsMs, text: '', skipped: false }
          if (sensitiveCount % 5 === 1) {
            // 别每帧都刷日志，每 5 帧打一条
            ctx.logger.info('单帧 VLM 命中内容审核（1026），跳过', {
              frame: frameFile,
              sensitiveCount,
            })
          }
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

      // v0.5 敏感内容阈值早退：累计/比例任一达标 → 整 stage 早退，避免烧完 60s 预算
      if (
        sensitiveCount >= SENSITIVE_ABORT_THRESHOLD ||
        (completed >= 5 && sensitiveCount / completed >= SENSITIVE_RATIO_THRESHOLD)
      ) {
        ctx.logger.warn('VLM 内容审核拒绝率过高，触发早退', {
          sensitiveCount,
          processed: completed,
          ratio: (sensitiveCount / completed).toFixed(2),
        })
        earlyExitTriggered = true
        break
      }

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
  /** VLM 并发数：v0.5 提到 16（M3 服务端 rate limit 通常能扛住，慢请求时高并发能压满）
   *  注意：太高可能触发 429，监控日志里 provider.rate-limited 频次 */
  concurrency: 16,
  /** 全局超时（ms）：v0.5 提到 180s
   *  之前 60s 在 M3 慢响应 + 高并发场景仍可能不够；提到 3 分钟让大部分场景跑完
   *  超时直接走 ASR 兜底 */
  globalTimeoutMs: 180_000,
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
  signal: AbortSignal | undefined,
  traceLogger: ChatInput['traceLogger'],
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
          text: `任务：识别这张视频画面里的**剧情对白字幕**（演员台词/旁白的烧录文字）。

**字幕的判定特征**（必须全部满足才算字幕）：
1. 位置：**画面底部** 5%-25% 的水平条带区域
2. 样式：白色/浅色字体 + 黑色描边 或 半透明黑底白字
3. 内容：是**演员说的话**或旁白（对白、独白、感叹），不是名词/标签/品牌
4. 形态：单行或两行（中英双语时），居中对齐

**以下都不是字幕，必须忽略**（即使画面里有文字也不要识别）：
- 画面顶部/侧边的**台标/水印**（如"芒果TV"、"优酷"、剧名）
- 招牌/路标/店名（如"XX公司"、"派出所"、"地铁站")
- 手机屏幕里的文字（聊天记录、APP 界面、通话名字）
- 电脑/电视屏幕内的文字
- 印刷品（书本、报纸、合同、菜单）
- 衣服/物品上的 logo / 文字
- 弹幕、表情包文字
- 角色心理活动用的**画面中央大字**（如"三年后"、"震惊"）
- 转场/标题卡里的文字
- 时间日期戳

**输出规则**：
- 底部有真字幕：直接返回字幕原文（保留标点 。！？），不加引号/解释
- 底部没字幕 或 底部文字属于上述忽略列表：返回空字符串
- 拿不准是字幕还是画面文字时：**倾向返回空字符串**（宁缺毋滥）

只返回字幕文本本身或空字符串，不要任何说明文字。`,
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
    traceLogger,
  })

  // 清理：去掉可能的引号、前缀、空格
  let text = res.text.trim()
  text = text.replace(/^["「『"]+|["」』"]+$/g, '').trim()
  text = text.replace(/^字幕[:：]?\s*/, '').trim()
  if (text === '空' || text === '无' || text === '没有字幕') return ''

  // v0.5 防御性 post-filter：M3 即便被 prompt 约束，仍偶尔会把画面文字误识为字幕。
  // 用启发式规则把明显的"非字幕"过滤掉——宁缺毋滥
  if (isLikelyNonSubtitleText(text)) return ''

  return text
}

/**
 * v0.5 启发式过滤：判断 M3 返回的文本是不是"明显的非字幕"。
 *
 * 规则按短剧场景的常见误识模式定的：
 *   - 纯英文/纯品牌名（"Apple"、"COCA-COLA"、"XYZ Company"）通常是 logo
 *   - 时间日期戳（"2026.01.15"、"08:30"）通常是画面时间显示
 *   - 极短的纯数字（"123"、"888"）通常是楼号/门牌
 *   - 含明显"非台词"关键词（"XX公司"、"派出所"、"医院"、"地铁站"等）
 *   - 极短（≤1 个汉字）几乎不可能是有意义的字幕
 */
const isLikelyNonSubtitleText = (text: string): boolean => {
  const t = text.trim()
  if (!t) return true

  // 极短文本：1 个汉字以下（含数字/字母）通常是误识
  if (t.length <= 1) return true

  // 纯英文/数字/标点（短剧字幕几乎全是中文）
  if (/^[A-Za-z0-9\s\-_.,!?'"()&/]+$/.test(t)) return true

  // 时间戳/日期格式
  if (/^\d{1,4}[年./:\-]\d{1,2}([月./:\-]\d{1,2})?$/.test(t)) return true
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true

  // 含明显"非台词"机构/场所关键词（出现就疑似招牌/标签）
  const NON_SUBTITLE_KEYWORDS = [
    '公司',
    '集团',
    '有限',
    '股份',
    '派出所',
    '警察局',
    '医院',
    '地铁',
    '机场',
    '车站',
    '酒店',
    '宾馆',
    '银行',
    '商场',
    '超市',
    '芒果TV',
    '优酷',
    '爱奇艺',
    '腾讯视频',
    'B站',
  ]
  // 但是这类关键词在台词里也可能出现（"我去过这家公司"），所以加判断：
  // 整段文本**短且主要由该关键词构成** → 大概率是招牌
  for (const kw of NON_SUBTITLE_KEYWORDS) {
    if (t.includes(kw) && t.length <= kw.length + 4) return true
  }

  return false
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
