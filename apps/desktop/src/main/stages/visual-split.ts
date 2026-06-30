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
  /** LLM 给的标签，比如 "黑发短发"、"棕发卷发" */
  label: string
  /** 该组包含的 segment ID */
  segmentIds: string[]
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

  // v2：所有 segments 都送 LLM，不再采样
  // 短剧场景单 speaker 的 segments 一般 < 20 个，base64 thumb 240px 每张 ~10KB，
  // 全部送过去 < 200KB 完全没问题
  const MAX_FRAMES = 24
  const ordered = segments.slice(0, MAX_FRAMES) // 极端长剧才限制，正常都不会触发

  if (ordered.length < segments.length) {
    ctx.logger.warn('视觉拆分：segment 超过上限，截断', {
      speakerId,
      total: segments.length,
      kept: ordered.length,
    })
  }

  // 抽帧
  const frameSegMap = new Map<number, { segId: string; thumbPath: string }>()
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!
    const tmpPath = join(splitThumbsDir, `${speakerId}-${i}.jpg`)
    const midSec = ((s.startMs + (s.endMs - s.startMs) / 2) / 1000).toFixed(3)
    let thumbPath: string | null = null
    if (!existsSync(tmpPath)) {
      try {
        const r = await runCmd(ffmpeg, [
          '-ss',
          midSec,
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
        if (r.code === 0 && existsSync(tmpPath)) thumbPath = tmpPath
      } catch (err) {
        ctx.logger.warn('视觉拆分抽帧失败', { speakerId, segId: s.id, err: String(err) })
      }
    } else {
      thumbPath = tmpPath
    }
    if (thumbPath) {
      frameSegMap.set(i, { segId: s.id, thumbPath })
    }
  }

  if (frameSegMap.size < 2) {
    ctx.logger.info('视觉拆分：可用帧不足 2，跳过', { speakerId })
    return null
  }

  // 调 LLM Vision
  try {
    const result = await askLlmVisionSplit(
      ctx.logger,
      Array.from(frameSegMap.entries()).map(([idx, v]) => ({ idx, ...v })),
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
        splitGroups.push({ label: grp.label, segmentIds: ids })
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
}

const askLlmVisionSplit = async (
  logger: StageLogger,
  frames: Array<{ idx: number; segId: string; thumbPath: string }>,
  signal: AbortSignal,
): Promise<LlmGroupResult[] | null> => {
  const llm = providers().llm

  // 构造多模态 content：每张图前面加一个 text 标注 frame idx
  const userBlocks: ContentBlock[] = [
    {
      type: 'text',
      text:
        `下面是同一个 speaker 的 ${frames.length} 张画面（来自不同台词片段）。\n\n` +
        `**任务**：判断这些画面里是不是同一个人在说话。如果是多个不同的人，把每张画面归类到对应的人。\n\n` +
        `**判断依据**（按优先级）：\n` +
        `1. 头发颜色 / 发型（黑发、棕发、卷发、短发、长发）\n` +
        `2. 服装（衣服颜色 / 款式）\n` +
        `3. 面部特征（如果能看清）\n\n` +
        `**关键规则**：\n` +
        `- 输入有 N 张画面，你的输出 JSON 里 frame_indices 列出的所有数字加起来必须**覆盖全部 N 张**，**一张不漏**\n` +
        `- 每张画面**只能**归到 1 个组（不能在多个 frame_indices 里出现）\n` +
        `- 如果都是同一人（只是表情/角度不同），返回 1 个组（包含全部 frame_indices）\n` +
        `- 如果能明显看出多个不同的人，返回多个组（每组的 label 用"发色+服装"简述）\n` +
        `- 拿不准时倾向"同一人"，但**别漏 frame**\n\n` +
        `**输出**（严格 JSON，不要 markdown）：\n` +
        `{"groups": [{"label": "<外貌特征>", "frame_indices": [<画面编号>...]}]}\n\n` +
        `画面如下（每张前标了 frame=N）：`,
    },
  ]

  for (const f of frames) {
    if (!existsSync(f.thumbPath)) continue
    const buf = await readFile(f.thumbPath)
    const b64 = buf.toString('base64')
    userBlocks.push({ type: 'text', text: `\n--- frame=${f.idx} ---` })
    userBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: b64,
      },
    })
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是视频角色识别助手。看几张同一片段里的画面，判断里面是不是同一个说话人。严格按规则输出 JSON，不要解释、不要 markdown fence。',
    },
    { role: 'user', content: userBlocks },
  ]

  logger.info('视觉拆分 LLM 调用', {
    frameCount: frames.length,
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
  // 字段校验
  const valid = parsed.groups
    .filter(
      (g) =>
        typeof g.label === 'string' &&
        Array.isArray(g.frame_indices) &&
        g.frame_indices.every((n) => typeof n === 'number'),
    )
    .map((g) => ({ label: g.label, frame_indices: g.frame_indices }))
  if (valid.length === 0) return null
  logger.info('视觉拆分 LLM 结果', {
    groupCount: valid.length,
    groups: valid.map((g) => ({ label: g.label, frameCount: g.frame_indices.length })),
  })
  return valid
}
