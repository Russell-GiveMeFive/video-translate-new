import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Stage, StageRunContext, StageResult, ChatMessage } from '@dramaprime/core-types'
import { asProjectId, asSegmentId } from '@dramaprime/core-types'
import {
  DEFAULT_ALIGN_CONFIG,
  planAlignment,
  type AlignConfig,
  type AlignPlan,
  type AlignTarget,
} from '@dramaprime/align-engine'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { db } from '../storage/index.js'
import { timeStretch, hasRubberband } from '../ffmpeg/timestretch.js'

/**
 * v0.3 align stage：
 *   1. 从 SQLite 读 segments（含 tgtAudioPath + tgtDurMs）
 *   2. planner 决定每句策略（fit/sola/gap-borrow/video-slow/overflow）
 *   3. 需要 SOLA 的句子调 timeStretch 产出 <seg>.aligned.mp3
 *   4. 把 AlignDecision 写回 segments.align_decision_json + flag 字段
 *
 * mix-render 之后会优先用 .aligned.mp3 而不是原 .mp3。
 */
export const alignStage: Stage = {
  name: 'align',
  version: 1,
  inputsFrom: ['tts-synth'],
  blocking: false, // 失败 → 回退用未对齐的 TTS，不阻塞 mix-render
  retries: 1,
  kind: 'main',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const segs = SegmentRepo.list(ctx.projectId as any).filter(
      (s) => s.tgtAudioPath && s.tgtDurMs != null && existsSync(s.tgtAudioPath),
    )
    if (segs.length === 0) {
      return { kind: 'skipped', reason: '没有可对齐的 segments（缺 TTS 产物）' }
    }
    ctx.logger.info('align 开始', {
      total: segs.length,
      rubberband: hasRubberband(),
    })

    const characters = CharacterRepo.list(ctx.projectId as any)
    const voiceById = new Map(characters.map((c) => [c.id, c.voiceId]))

    // 读项目配置覆盖 align 默认（D2 等决议）
    const cfg: AlignConfig = {
      ...DEFAULT_ALIGN_CONFIG,
      toleranceMs: project.config.align.toleranceMs,
      enableVideoSlow: project.config.align.enableVideoSlow,
      videoSlowMaxRatio: project.config.align.videoSlowMaxRatio,
    }

    // ── 重译压缩循环（用户决议：TTS 长溢出 → 让 LLM 重写简略版，最多 2 轮） ──
    // 每轮：
    //   1. 找出"TTS 超长且 SOLA 救不回"的 segments
    //   2. 调 LLM 重译为更短版本（带 target_dur 提示）
    //   3. 重新 TTS（用现有 voice）
    //   4. 回到 step 1，直到没溢出 / 达到最大轮数 / 重译失败
    const llm = providers().llm
    const tts = providers().tts
    const MAX_RETRY_ROUNDS = 2
    let segsForAlign = segs
    for (let round = 0; round < MAX_RETRY_ROUNDS; round++) {
      const targets = buildTargets(segsForAlign, voiceById)
      const overflowed = findOverflowSegments(targets, cfg)
      if (overflowed.length === 0) {
        ctx.logger.info(`重译循环 round=${round}：没有溢出，进入 planner`)
        break
      }
      ctx.logger.info(`重译循环 round=${round}：发现 ${overflowed.length} 个溢出 segment，开始压缩重译`, {
        overflowed: overflowed.map((o) => ({
          segId: o.segmentId,
          ttsMs: o.ttsDurMs,
          origMs: o.originalDurMs,
          ratio: round3(o.ttsDurMs / o.originalDurMs),
        })),
      })
      ctx.reportProgress(
        Math.round((round / MAX_RETRY_ROUNDS) * 30),
        `重译压缩 round ${round + 1}/${MAX_RETRY_ROUNDS}（${overflowed.length} 句）`,
      )

      // 批量重译
      const newTexts = await retranslateBatch(llm, overflowed, project.targetLang, ctx)
      // 更新 SQLite tgt_text
      const updTextStmt = db().prepare(`UPDATE segments SET tgt_text = ? WHERE id = ?`)
      const tx1 = db().transaction(() => {
        for (const [segId, text] of newTexts) {
          if (text) updTextStmt.run(text, segId)
        }
      })
      tx1()

      // 重新 TTS（只对重译过的 segments）
      await retssBatch(tts, overflowed, newTexts, voiceById, segsForAlign, ctx, project)

      // 重新加载 segments
      segsForAlign = SegmentRepo.list(ctx.projectId as any).filter(
        (s) => s.tgtAudioPath && s.tgtDurMs != null && existsSync(s.tgtAudioPath),
      )
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
    }

    // 构造最终 AlignTarget
    const targets = buildTargets(segsForAlign, voiceById)

    ctx.reportProgress(40, '生成对齐计划')
    const plans = planAlignment(targets, cfg)

    // 统计计划分布（便于 UI / 日志）
    const counts: Record<string, number> = {}
    for (const p of plans) counts[p.decision.strategy] = (counts[p.decision.strategy] ?? 0) + 1
    ctx.logger.info('对齐策略分布', counts)

    // 执行 SOLA 变速
    const solaPlans = plans.filter((p) => p.needsSolaTransform && p.solaRatio != null)
    let solaDone = 0
    for (const plan of solaPlans) {
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
      const t = targets.find((x) => x.segmentId === plan.segmentId)!
      const dir = dirname(t.ttsAudioPath)
      const ext = extname(t.ttsAudioPath)
      const base = basename(t.ttsAudioPath, ext)
      const outPath = join(dir, `${base}.aligned${ext}`)
      try {
        await timeStretch({
          inputPath: t.ttsAudioPath,
          outputPath: outPath,
          ratio: plan.solaRatio!,
          signal: ctx.signal,
        })
        // 把"对齐后路径"也写回（mix-render 优先用这个）
        db()
          .prepare(`UPDATE segments SET tgt_audio_path = ? WHERE id = ?`)
          .run(outPath, t.segmentId)
      } catch (err) {
        ctx.logger.warn('SOLA 变速失败，回退原 TTS 音频', {
          segId: t.segmentId,
          err: String((err as any)?.message ?? err),
        })
        // 改成 overflow 标红
        plan.decision = {
          strategy: 'overflow',
          finalDurMs: t.ttsDurMs,
          offsetMs: t.ttsDurMs - t.originalDurMs,
          flag: 'red',
        }
        plan.needsSolaTransform = false
      }
      solaDone++
      ctx.reportProgress(
        5 + Math.round((solaDone / Math.max(1, solaPlans.length)) * 80),
        `SOLA 变速 ${solaDone}/${solaPlans.length}`,
      )
    }

    // 回写 align_decision + flag
    ctx.reportProgress(90, '写入对齐决策')
    const updateStmt = db().prepare(
      `UPDATE segments SET align_decision_json = ?, flag = ? WHERE id = ?`,
    )
    const tx = db().transaction(() => {
      for (const p of plans) {
        updateStmt.run(JSON.stringify(p.decision), p.decision.flag, p.segmentId)
      }
    })
    tx()

    ctx.reportProgress(
      100,
      `对齐完成 ${plans.length} 句（${formatCountsLabel(counts)}）`,
    )
    return {
      kind: 'ok',
      outputs: { total: String(plans.length), counts: JSON.stringify(counts) },
      durationMs: Date.now() - t0,
    }
  },
}

// path helpers
const dirname = (p: string): string => p.substring(0, p.lastIndexOf('/'))
const basename = (p: string, ext: string): string => {
  const filename = p.substring(p.lastIndexOf('/') + 1)
  return ext ? filename.substring(0, filename.length - ext.length) : filename
}
const extname = (p: string): string => {
  const i = p.lastIndexOf('.')
  const sep = p.lastIndexOf('/')
  return i > sep ? p.substring(i) : ''
}

const formatCountsLabel = (counts: Record<string, number>): string => {
  const order = ['fit', 'sola', 'gap-borrow', 'video-slow', 'overflow']
  return order
    .filter((k) => counts[k])
    .map((k) => `${k}:${counts[k]}`)
    .join(' ')
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

// ── 重译压缩相关 helpers ─────────────────────────────────────────────

type SegRow = ReturnType<typeof SegmentRepo.list>[number]

const buildTargets = (
  segs: SegRow[],
  voiceById: Map<string, string | null>,
): AlignTarget[] =>
  segs.map((s) => ({
    segmentId: s.id,
    originalStartMs: s.startMs,
    originalEndMs: s.endMs,
    originalDurMs: s.endMs - s.startMs,
    ttsAudioPath: s.tgtAudioPath!,
    ttsDurMs: s.tgtDurMs!,
    tgtText: s.tgtTextEdited ?? s.tgtText ?? '',
    voiceId: (s.characterId && voiceById.get(s.characterId)) ?? null,
  }))

/**
 * 判断 TTS 是否"严重溢出且 SOLA 救不回"——这种 segment 需要回头压缩重译。
 *
 * 标准：ttsDur / origDur > SOLA 上限（默认 1.3）且 > tolerance
 * 即使开了 video-slow 也无法救（video-slow 上限默认 5%，远不够）
 */
const findOverflowSegments = (
  targets: AlignTarget[],
  cfg: AlignConfig,
): AlignTarget[] =>
  targets.filter((t) => {
    const ratio = t.ttsDurMs / Math.max(1, t.originalDurMs)
    const offset = t.ttsDurMs - t.originalDurMs
    // 仅"长出来太多"算溢出；短出来由 video-slow 拉长视频解决
    if (offset <= cfg.toleranceMs) return false
    return ratio > cfg.solaRange[1]
  })

/**
 * 批量调 LLM 重译——目标更短，且给出明确的 char_budget。
 */
const retranslateBatch = async (
  llm: ReturnType<typeof providers>['llm'],
  overflowed: AlignTarget[],
  targetLang: string,
  ctx: StageRunContext,
): Promise<Map<string, string>> => {
  const langLabel = LANG_LABEL[targetLang] ?? targetLang
  // 估算每句目标字数：以 ttsDurMs/origDurMs 比例反推应砍到的字数
  // 当前译文 N 字，目标 = N × (origDur / ttsDur) × 0.85（额外 15% 余量）
  const items = overflowed.map((t) => {
    const currentChars = t.tgtText.length
    const targetChars = Math.max(
      4,
      Math.round(currentChars * (t.originalDurMs / t.ttsDurMs) * 0.85),
    )
    return {
      segId: t.segmentId,
      current: t.tgtText,
      target_dur_ms: t.originalDurMs,
      current_dur_ms: t.ttsDurMs,
      target_chars: targetChars,
    }
  })

  const systemPrompt = `你是专业短剧译制译者。当前译文在配音时超过画面槽位时长，需要压缩为更短的${langLabel}版本。

要求：
1. 保留**核心意思与情绪**——可以删修饰语、简化句式、用更口语化短词，但不能丢台词关键信息
2. 每句长度 ≤ target_chars 字符（这是硬约束！）
3. 用更自然口语的${langLabel}短句，不要书面化
4. **严格 1:1 改写**：输入 N 句就输出 N 个键值对
5. 仅输出 JSON 对象，不要解释。key 用 segId 原样。

输出格式：
{
  "<segId>": "<压缩后的译文>",
  ...
}`

  const userPrompt = `请把以下 ${items.length} 句译文压缩为更短的版本：

${JSON.stringify(items, null, 2)}

直接返回 JSON。`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  const out = new Map<string, string>()
  try {
    const res = await llm.chat({
      model: 'MiniMax-M3',
      messages,
      maxTokens: 2048,
      temperature: 0.5,
      expectJson: true,
      signal: ctx.signal,
    })
    // 解析 JSON
    const cleaned = res.text.trim()
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const jsonStr = fence?.[1]?.trim() ?? cleaned
    const start = jsonStr.indexOf('{')
    const end = jsonStr.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('LLM 返回不是 JSON 对象')
    const data = JSON.parse(jsonStr.slice(start, end + 1)) as Record<string, string>
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.trim()) out.set(k, v.trim())
    }
    if (res.costCents > 0) {
      ctx.reportCost({
        projectId: asProjectId(ctx.projectId as any),
        stage: 'align',
        provider: 'MiniMax',
        model: 'MiniMax-M3',
        units: res.usage.promptTokens + res.usage.completionTokens,
        unitKind: 'tokens',
        cents: res.costCents,
        ts: Date.now(),
      })
    }
    ctx.logger.info('重译压缩 LLM 返回', {
      requested: overflowed.length,
      returned: out.size,
    })
  } catch (err) {
    ctx.logger.warn('重译压缩 LLM 调用失败，跳过本轮压缩', {
      err: String((err as any)?.message ?? err),
    })
  }
  return out
}

/**
 * 批量重新 TTS（针对重译后的 segments）。
 */
const retssBatch = async (
  tts: ReturnType<typeof providers>['tts'],
  overflowed: AlignTarget[],
  newTexts: Map<string, string>,
  voiceById: Map<string, string | null>,
  segsAll: SegRow[],
  ctx: StageRunContext,
  project: ReturnType<typeof ProjectRepo.get>,
): Promise<void> => {
  const segMap = new Map<string, SegRow>(segsAll.map((s) => [s.id as string, s]))
  const ttsDir = join(ctx.projectDir, 'tts')

  for (const t of overflowed) {
    if (ctx.signal.aborted) return
    const newText = newTexts.get(t.segmentId)
    if (!newText) continue
    const seg = segMap.get(t.segmentId)
    if (!seg) continue
    const character = seg.characterId
      ? { voiceId: voiceById.get(seg.characterId) ?? null, gender: null as null | string }
      : null
    const voiceId = character?.voiceId ?? t.voiceId ?? 'female-shaonv'

    try {
      const tuning = emotionTuningForAlign(seg.emotion)
      const out = await tts.synthesize({
        model: project.config.tts.model,
        text: enrichTextWithPausesForAlign(newText, seg.emotion),
        voiceId,
        format: 'mp3',
        sampleRate: 32_000,
        emotion: seg.emotion ?? undefined, // 重译后保持情绪
        emotionIntensity: tuning.intensity,
        speed: tuning.speed,
        vol: tuning.vol,
        pitch: tuning.pitch,
        signal: ctx.signal,
      })
      // 把新 TTS 文件覆盖旧的
      const dst = join(ttsDir, `${seg.id}.mp3`)
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
        .run(dst, out.durationMs, seg.id)
      ctx.logger.info('重译后 TTS 重新合成', {
        segId: seg.id,
        oldMs: t.ttsDurMs,
        newMs: out.durationMs,
      })
    } catch (err) {
      ctx.logger.warn('重译后 TTS 失败，保留旧版', {
        segId: seg.id,
        err: String((err as any)?.message ?? err),
      })
    }
  }
}

const LANG_LABEL: Record<string, string> = {
  en: '英语',
  es: '西班牙语',
  pt: '葡萄牙语',
  ja: '日语',
  id: '印尼语',
  ko: '韩语',
  vi: '越南语',
  th: '泰语',
  ar: '阿拉伯语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
}

// 重译后 TTS 复用 tts-stage 的情绪调优——这里复制一份避免跨文件依赖
// 表保持一致：tts-stage.ts 改了这里也要同步改（虽然丑但简单）
interface AlignEmotionTuning {
  intensity: number
  speed: number
  vol: number
  pitch: number
}
const ALIGN_EMOTION_TUNING: Record<string, AlignEmotionTuning> = {
  // 与 tts-stage 保持一致：保守范围避免失真
  angry: { intensity: 1.4, speed: 1.03, vol: 1.1, pitch: 1 },
  happy: { intensity: 1.3, speed: 1.03, vol: 1.05, pitch: 1 },
  sad: { intensity: 1.3, speed: 0.95, vol: 0.9, pitch: -1 },
  surprised: { intensity: 1.4, speed: 1.05, vol: 1.05, pitch: 1 },
  fearful: { intensity: 1.3, speed: 1.03, vol: 0.95, pitch: 0 },
  disgusted: { intensity: 1.3, speed: 0.98, vol: 1.0, pitch: 0 },
  neutral: { intensity: 1.0, speed: 1.0, vol: 1.0, pitch: 0 },
}
const emotionTuningForAlign = (raw: string | null | undefined): AlignEmotionTuning => {
  if (!raw) return ALIGN_EMOTION_TUNING.neutral!
  const key = raw.trim().toLowerCase()
  const mapped =
    key === 'surprise' ? 'surprised' :
    key === 'fear' ? 'fearful' :
    key === 'disgust' ? 'disgusted' :
    key
  return ALIGN_EMOTION_TUNING[mapped] ?? ALIGN_EMOTION_TUNING.neutral!
}
const enrichTextWithPausesForAlign = (
  text: string,
  emotion: string | null | undefined,
): string => {
  if (!text) return text
  const e = (emotion ?? '').trim().toLowerCase()
  if (/<#\d/.test(text)) return text
  // 与 tts-stage 保持一致：只 sad / surprised 在第一个句末加极轻 0.15s
  let hardPause = 0
  if (e === 'sad') hardPause = 0.15
  else if (e === 'surprised' || e === 'surprise') hardPause = 0.15
  if (hardPause === 0) return text
  let added = false
  return text.replace(/([。！？!?])(?=\s*\S)/g, (m) => {
    if (added) return m
    added = true
    return `${m}<#${hardPause.toFixed(2)}#>`
  })
}
