import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChatMessage,
  ContentBlock,
  Segment,
  StageLogger,
  StageRunContext,
} from '@dramaprime/core-types'
import { isAppError } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'

/**
 * 视觉辅助拆分 speaker——给 cluster stage 用。
 *
 *   动机：Volcano speaker diarization 对兄弟/双胞胎/同年龄段同性别声音容易合并到
 *         同一 speaker_id。LLM Vision 看画面就能区分（不同发色/发型/服装），帮忙拆。
 *
 *   策略（v2，修复 v1 bug）：
 *     1. 对每个 speaker_id 下 segments >= 2 的组才调（单 segment 没歧义）
 *     2. **每个 segment 都抽 thumb 给 LLM**，让 LLM 一次性给所有 frame 打标签
 *        （短剧通常 < 20 个 segments，喂完不贵也更准）
 *     3. LLM 返回 JSON：{groups: [{label, frame_indices: [...]}, ...]}
 *     4. 不再有"未采样兜底"——LLM 必须给每个 frame 都归类
 *
 *   失败兜底：网络 / LLM 返回非 JSON / 调用异常 → 直接返回 null，cluster 用原分组
 */

export interface SubSpeakerGroup {
  /** LLM 给的外观标签，比如 "黑发短发"、"棕发卷发"（命名失败时 fallback 用） */
  label: string
  /** 该组包含的 segment ID */
  segmentIds: string[]
  /** v0.5 命名升级：性别（"男"/"女"/null） */
  gender?: '男' | '女' | null
  /** v0.5 命名升级：角色定位/称谓（"妹妹"/"老板"/"旁白"/null） */
  role?: string | null
  /** v0.5 命名升级：从台词里挖出的人名（"小芸"/"王总"/null） */
  name?: string | null
}

/**
 * 对一个 speaker 的 segments 调 LLM vision 判断该 speaker 实际是几个人。
 * 返回 null 表示无法拆（LLM 报错 / 返回 1 组 / segments 太少）。
 */
export async function trySplitSpeakerByVisual(
  ctx: StageRunContext,
  speakerId: string,
  segments: Segment[],
): Promise<SubSpeakerGroup[] | null> {
  if (segments.length < 2) return null

  const project = ProjectRepo.get(ctx.projectId as any)
  const ffmpeg = requireFfmpeg()
  const splitThumbsDir = join(ctx.projectDir, 'voices', '_split-thumbs')
  await mkdir(splitThumbsDir, { recursive: true })

  // v0.5 每段抽 3 帧（起/中/结），对抗**反打镜头 + 被遮挡瞬间**：
  //   - 现状每段抽 1 帧（中点），如果这一瞬间说话人正好被特写切走 → 视觉全错
  //   - 3 帧覆盖对话的完整过程，更可能落在"说话人正好露脸"那一帧
  // MAX_SEGMENTS 从 24 降到 8：单请求总图数 24 张不变，控制 base64 payload / M3 时延
  const MAX_SEGMENTS = 8
  const FRAMES_PER_SEGMENT = 3
  const ordered = segments.slice(0, MAX_SEGMENTS)

  if (ordered.length < segments.length) {
    ctx.logger.warn('视觉拆分：segment 超过上限，截断', {
      speakerId,
      total: segments.length,
      kept: ordered.length,
      framesPerSegment: FRAMES_PER_SEGMENT,
    })
  }

  // 抽帧：每段抽 3 张（起/中/结），存成 <speakerId>-<segIdx>-<fIdx>.jpg
  // frameSegMap 结构：segIdx → { segId, thumbPaths: [3 张] }
  const frameSegMap = new Map<number, { segId: string; thumbPaths: string[] }>()
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!
    const durMs = Math.max(1, s.endMs - s.startMs)
    // 起 = startMs + 10% 段长（避开切换瞬间），中 = 50%，结 = 90%
    // 都用相对偏移避免落在段边界
    const offsets = [0.1, 0.5, 0.9]
    const thumbPaths: string[] = []
    for (let f = 0; f < FRAMES_PER_SEGMENT; f++) {
      const tmpPath = join(splitThumbsDir, `${speakerId}-${i}-${f}.jpg`)
      const tSec = ((s.startMs + durMs * offsets[f]!) / 1000).toFixed(3)
      if (!existsSync(tmpPath)) {
        try {
          const r = await runCmd(ffmpeg, [
            '-ss',
            tSec,
            '-i',
            project.sourcePath,
            '-frames:v',
            '1',
            '-vf',
            'scale=240:-2',
            '-q:v',
            '5',
            '-y',
            tmpPath,
          ])
          if (r.code === 0 && existsSync(tmpPath)) thumbPaths.push(tmpPath)
        } catch (err) {
          ctx.logger.warn('视觉拆分抽帧失败', {
            speakerId,
            segId: s.id,
            frameOffset: offsets[f],
            err: String(err),
          })
        }
      } else {
        thumbPaths.push(tmpPath)
      }
    }
    if (thumbPaths.length > 0) {
      frameSegMap.set(i, { segId: s.id, thumbPaths })
    }
  }

  if (frameSegMap.size < 2) {
    ctx.logger.info('视觉拆分：可用段不足 2，跳过', { speakerId })
    return null
  }

  // 调 LLM Vision
  try {
    const result = await askLlmVisionSplit(
      ctx.logger,
      Array.from(frameSegMap.entries()).map(([idx, v]) => {
        // v0.5 命名升级：把 segment 的台词（ASR 原文 + OCR 字幕）传进去
        const seg = segments.find((s) => s.id === v.segId)
        return {
          idx,
          ...v,
          srcText: seg?.srcText ?? null,
          ocrText: seg?.ocrText ?? null,
        }
      }),
      ctx.signal,
    )
    if (!result || result.length <= 1) {
      ctx.logger.info('视觉拆分：LLM 认为是同一个人，保持原分组', { speakerId })
      return null
    }
    // 把 frame_indices 映射回 segment_ids；不再有"未采样兜底"
    const splitGroups: SubSpeakerGroup[] = []
    const allocatedFrames = new Set<number>()
    for (const grp of result) {
      const ids: string[] = []
      for (const i of grp.frame_indices) {
        const ent = frameSegMap.get(i)
        if (ent) {
          ids.push(ent.segId)
          allocatedFrames.add(i)
        }
      }
      if (ids.length > 0) {
        splitGroups.push({
          label: grp.label,
          segmentIds: ids,
          gender: grp.gender ?? null,
          role: grp.role ?? null,
          name: grp.name ?? null,
        })
      }
    }
    // 校验：LLM 应该给所有 frame 都分了组；如果有遗漏，记录但**不强制兜底**
    // （之前的 bug 就是兜底导致拆分失效）
    const missing: number[] = []
    for (const idx of frameSegMap.keys()) {
      if (!allocatedFrames.has(idx)) missing.push(idx)
    }
    if (missing.length > 0) {
      ctx.logger.warn('视觉拆分：LLM 漏给一些 frame 归类，按"最像哪组"启发式分配', {
        speakerId,
        missingFrames: missing,
      })
      // 启发式兜底：未归类的按 frame_index 邻近原则，归到最近被归类 frame 所在组
      // （短剧里同一人通常连续讲几句，邻近 frame 大概率是同一人）
      for (const m of missing) {
        const ent = frameSegMap.get(m)
        if (!ent) continue
        // 找前后最近的已归类 frame
        let nearestGrp: SubSpeakerGroup | null = null
        let nearestDist = Infinity
        for (const g of splitGroups) {
          for (const segId of g.segmentIds) {
            const matched = Array.from(frameSegMap.entries()).find(
              ([, v]) => v.segId === segId,
            )
            if (!matched) continue
            const dist = Math.abs(matched[0] - m)
            if (dist < nearestDist) {
              nearestDist = dist
              nearestGrp = g
            }
          }
        }
        if (nearestGrp) {
          nearestGrp.segmentIds.push(ent.segId)
        }
      }
    }
    return splitGroups
  } catch (err) {
    ctx.logger.warn('视觉拆分失败，保持原分组', {
      speakerId,
      err: String((err as any)?.message ?? err),
    })
    return null
  }
}

interface LlmGroupResult {
  label: string
  frame_indices: number[]
  /** v0.5 命名升级：从画面+台词推断出的性别 */
  gender?: '男' | '女' | null
  /** v0.5 命名升级：角色定位/称谓（如"妹妹"、"老板"、"旁白"） */
  role?: string | null
  /** v0.5 命名升级：人名（如"小芸"、"王总"），台词里挖不到则为 null */
  name?: string | null
}

const askLlmVisionSplit = async (
  logger: StageLogger,
  frames: Array<{
    idx: number
    segId: string
    thumbPaths: string[]
    srcText: string | null
    ocrText: string | null
  }>,
  signal: AbortSignal,
): Promise<LlmGroupResult[] | null> => {
  // v0.5 敏感图剔除重试：撞 1026 时根据错误的 content[N] 索引剔除该图，剩余 >=2 段重试
  // 最多 2 轮（避免每剔一张就重试导致无限循环 / 速率撞墙）
  const MAX_SENSITIVE_RETRIES = 2
  let candidates = frames
  for (let attempt = 0; attempt <= MAX_SENSITIVE_RETRIES; attempt++) {
    if (candidates.length < 2) {
      logger.info('视觉拆分：剔除敏感图后剩余段不足 2，放弃', {
        attempt,
        remaining: candidates.length,
      })
      return null
    }
    try {
      return await attemptVisionCall(logger, candidates, signal)
    } catch (err) {
      // 只对 1026 内容审核做剔除重试，其他错误直接抛
      if (!isAppError(err) || err.code !== 'provider.content-sensitive') {
        throw err
      }
      const sensitiveIdx = (err.context as any)?.sensitiveContentIndex as number | undefined
      // v0.5 每段 K 张图（K = candidates[0].thumbPaths.length），
      // userBlocks 布局：[intro] + 每段 [text + K 张 image]
      const framesPerSeg = candidates[0]?.thumbPaths.length ?? 1
      const segIdxToRemove = contentIndexToFrameIdx(
        sensitiveIdx,
        candidates.length,
        framesPerSeg,
      )
      if (segIdxToRemove == null || segIdxToRemove >= candidates.length) {
        // 没解析出索引或越界 → 没法精准剔除，放弃
        logger.warn('视觉拆分撞 1026 但无法解析敏感图索引，放弃重试', {
          sensitiveContentIndex: sensitiveIdx,
          segmentCount: candidates.length,
          framesPerSeg,
        })
        return null
      }
      const dropped = candidates[segIdxToRemove]!
      logger.warn('视觉拆分撞 1026，剔除敏感段后重试', {
        attempt: attempt + 1,
        droppedSegIdx: dropped.idx,
        droppedSegId: dropped.segId,
        droppedFrameCount: dropped.thumbPaths.length,
        remainingAfterDrop: candidates.length - 1,
      })
      candidates = candidates.filter((_, i) => i !== segIdxToRemove)
    }
  }
  logger.warn('视觉拆分：达到最大重试次数仍撞内容审核，放弃')
  return null
}

/**
 * v0.5 每段抽 K 张图：
 * userBlocks 结构 = [intro] + 每段 [text(seg) + image × K]
 * 即除 intro 外，每段占 K+1 块，segIdx = Math.floor((N - 1) / (K + 1))
 *
 * 若 M3 报的 content[N] 落在 intro（N=0）或异常位置 → 返回 null，上层放弃重试。
 *
 * 剔除粒度是**段**而不是单张——同一段的 3 张图属于同一 segment，敏感的通常是画面
 * 内容本身敏感，同段其他角度也大概率敏感，直接剔整段更干净。
 */
const contentIndexToFrameIdx = (
  contentIndex: number | undefined,
  totalSegments: number,
  framesPerSeg: number,
): number | null => {
  if (contentIndex == null || contentIndex < 1) return null
  const perSegBlocks = framesPerSeg + 1 // 1 text + K images
  const segIdx = Math.floor((contentIndex - 1) / perSegBlocks)
  if (segIdx >= 0 && segIdx < totalSegments) return segIdx
  return null
}

const attemptVisionCall = async (
  logger: StageLogger,
  frames: Array<{
    idx: number
    segId: string
    thumbPaths: string[]
    srcText: string | null
    ocrText: string | null
  }>,
  signal: AbortSignal,
): Promise<LlmGroupResult[] | null> => {
  const llm = providers().llm

  // 构造多模态 content：每段 text 上下文 + 该段的多张图（起/中/结）
  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
        `下面是同一个 speaker 的 ${frames.length} 段台词。每段配 3 张画面（起/中/结）+ 台词文本。\n\n` +
        `**双重任务**：\n` +
        `1. **拆分判断**：这些段是不是同一个人说的？如果是多人，把每段归类\n` +
        `2. **角色命名**：给每个人**自身的**身份打标（不是 ta 在谈论的别人！）\n\n` +
        `**拆分依据**（按优先级）：\n` +
        `- 头发颜色 / 发型（黑发、棕发、卷发、短发、长发）\n` +
        `- 服装（衣服颜色 / 款式）\n` +
        `- 面部特征（如果能看清）\n\n` +
        `**如何用 3 张画面判断说话人**（这个很重要）：\n` +
        `- 短剧对话戏常有**反打镜头**——A 说话时镜头对着 B 听。3 张画面里可能出现不同人\n` +
        `- 找**多张画面里稳定出现的那个人**——那个更可能是本段说话人\n` +
        `- 优先看**嘴巴在动或表情在说话**的人（如果能判断出来）\n` +
        `- 如果 3 张里全是不同人（快速切镜），综合判断"哪个身份跟台词最契合"\n\n` +
        `**命名依据**（用画面 + 台词综合判断**这个说话人自己是谁**）：\n` +
        `- gender："男" / "女"（看人脸 + 听台词里"我是男的/女的"等线索）\n` +
        `- role：这个角色在剧里的**身份/称谓**\n` +
        `   * 听台词里别人怎么称呼**ta**："哥/姐/妹妹/老板/王总/老师"\n` +
        `   * **注意**：不是 ta 在说的称呼。"我妹妹来了"的说话人是哥哥，不是妹妹\n` +
        `   * 实在挖不出叫"路人"或具体场景如"旁白/警察/医生"\n` +
        `- name：从台词中明确出现的**人名/外号**（"小芸"、"王总"、"老李"）\n` +
        `   * 必须是台词里**别人喊 ta** 或 **ta 自报家门**的名字\n` +
        `   * 没出现就填 null，不要瞎编\n\n` +
        `**关键规则**：\n` +
        `- 输入有 N 段，frame_indices 里的数字加起来必须覆盖全部 N 段，一段不漏\n` +
        `- 每段只能归到 1 个组（frame_indices 是段索引，不是图片索引）\n` +
        `- 拿不准是同人还是分人时倾向"同一人"\n` +
        `- label 保留外观描述（"黑发深蓝外套青年"），作为命名失败时的兜底\n\n` +
        `**输出**（严格 JSON，不要 markdown）：\n` +
        `{"groups":[{"label":"<外观描述>","gender":"男"|"女"|null,"role":"<身份称谓>"|null,"name":"<人名>"|null,"frame_indices":[...]}]}\n\n` +
        `画面 + 台词如下：`,
    },
  ]

  for (const f of frames) {
    // 拼台词上下文：优先 srcText（ASR），ocrText（字幕）作补充
    const lines: string[] = [`\n--- segment=${f.idx}（该段 ${f.thumbPaths.length} 张画面：起/中/结）---`]
    if (f.srcText) lines.push(`台词(ASR): ${f.srcText}`)
    if (f.ocrText && f.ocrText !== f.srcText) lines.push(`字幕(OCR): ${f.ocrText}`)
    userBlocks.push({ type: 'text', text: lines.join('\n') })
    // 该段的所有 thumb 依次跟在同一 text 块后面
    for (const thumbPath of f.thumbPaths) {
      if (!existsSync(thumbPath)) continue
      const buf = await readFile(thumbPath)
      const b64 = buf.toString('base64')
      userBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: b64,
        },
      })
    }
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是视频角色识别助手。看每段的多张画面（起/中/结）+ 对应台词，判断说话人是谁，并给出性别/身份/人名。' +
        '严格区分"说话人自己的身份"和"ta 在谈论的人"。' +
        '注意短剧反打镜头：段里出现的人不一定就是说话人，找稳定出现且开口的那个。' +
        '严格按规则输出 JSON，不要解释、不要 markdown fence。',
    },
    { role: 'user', content: userBlocks },
  ]

  logger.info('视觉拆分 LLM 调用', {
    segmentCount: frames.length,
    framesPerSeg: frames[0]?.thumbPaths.length ?? 0,
    totalImages: userBlocks.filter((b) => b.type === 'image').length,
    totalBase64Bytes: userBlocks
      .filter((b) => b.type === 'image')
      .reduce((acc, b) => acc + (b as any).source.data.length, 0),
  })

  const res = await llm.chat({
    model: 'MiniMax-M3',
    messages,
    maxTokens: 512,
    temperature: 0.3,
    expectJson: true,
    signal,
    // v0.5 trace 钩子：所有 M3 调用打日志（含 requestId/url/耗时）
    traceLogger: (ev) => {
      const fn = ev.level === 'error' ? logger.error : ev.level === 'warn' ? logger.warn : logger.info
      fn.call(logger, `M3 ${ev.kind}`, { ...ev, scene: 'visual-split' })
    },
  })

  // 解析
  const text = res.text.trim()
  let jsonStr = text
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) jsonStr = fence[1].trim()
  const start = jsonStr.indexOf('{')
  const end = jsonStr.lastIndexOf('}')
  if (start < 0 || end <= start) {
    logger.warn('视觉拆分 LLM 返回非 JSON', { textPrefix: text.slice(0, 200) })
    return null
  }
  const parsed = JSON.parse(jsonStr.slice(start, end + 1)) as { groups?: LlmGroupResult[] }
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) return null
  // 字段校验：label + frame_indices 必填，gender/role/name 可选
  const normalizeGender = (g: unknown): '男' | '女' | null => {
    if (g === '男' || g === '女') return g
    return null
  }
  const normalizeStr = (s: unknown): string | null => {
    if (typeof s !== 'string') return null
    const t = s.trim()
    if (!t || t === 'null' || t === 'unknown' || t === '未知') return null
    return t
  }
  const valid = parsed.groups
    .filter(
      (g) =>
        typeof g.label === 'string' &&
        Array.isArray(g.frame_indices) &&
        g.frame_indices.every((n) => typeof n === 'number'),
    )
    .map((g) => ({
      label: g.label,
      frame_indices: g.frame_indices,
      gender: normalizeGender(g.gender),
      role: normalizeStr(g.role),
      name: normalizeStr(g.name),
    }))
  if (valid.length === 0) return null
  logger.info('视觉拆分 LLM 结果', {
    groupCount: valid.length,
    groups: valid.map((g) => ({
      label: g.label,
      gender: g.gender,
      role: g.role,
      name: g.name,
      frameCount: g.frame_indices.length,
    })),
  })
  return valid
}
