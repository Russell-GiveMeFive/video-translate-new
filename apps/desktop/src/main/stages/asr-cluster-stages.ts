import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  Stage,
  StageRunContext,
  StageResult,
  AsrUtterance,
  AsrWord,
} from '@dramaprime/core-types'
import { asCharacterId, asProjectId } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { db } from '../storage/index.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'
import { trySplitSpeakerByVisual } from './visual-split.js'

/**
 * asr-diarize：
 *   1. ffmpeg 把源视频抽成 16k mono s16le PCM wav（火山流式 ASR 要求）
 *   2. 调 provider.asr.transcribe()（v0.2.b1 后接火山真实；缺 key 时仍 mock）
 *   3. 把 utterances 落 SQLite segments；同时把 gender/emotion 写到 emotion 字段
 *   4. provider 返回的 utterances 里的 gender 字段在 cluster 阶段聚合写回 characters.gender
 */
export const asrDiarizeStage: Stage = {
  name: 'asr-diarize',
  version: 2, // v2: 真实 ffmpeg 抽音 + 真实火山 ASR
  inputsFrom: ['demix'],
  blocking: true,
  retries: 2,
  kind: 'provider',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const sourcePath = project.sourcePath
    if (!existsSync(sourcePath)) {
      return {
        kind: 'failed',
        error: {
          code: 'user.file-not-found',
          message: `源视频不存在：${sourcePath}`,
          retriable: false,
        },
      }
    }

    // ── Step 1: 抽 16k mono s16le PCM wav 给 ASR ───────────────
    // 优先用 demix 阶段产出的 vocals.wav（纯人声、识别更准）；没有就从源视频抽
    ctx.reportProgress(5, '抽取音频')
    const audioDir = join(ctx.projectDir, 'stems')
    await mkdir(audioDir, { recursive: true })
    const wavPath = join(audioDir, 'vocals-asr.wav')
    const ffmpeg = requireFfmpeg()
    const demixVocals = join(ctx.projectDir, 'stems', 'vocals.wav')
    const asrInputSource = existsSync(demixVocals) ? demixVocals : sourcePath
    ctx.logger.info('asr 输入音频源', {
      useVocals: asrInputSource === demixVocals,
      asrInputSource,
    })
    const r = await runCmd(
      ffmpeg,
      [
        '-i',
        asrInputSource,
        '-vn', // 去视频流
        '-ac',
        '1', // mono
        '-ar',
        '16000', // 16k
        '-acodec',
        'pcm_s16le',
        '-y',
        wavPath,
      ],
      { signal: ctx.signal },
    )
    if (r.code !== 0 || !existsSync(wavPath)) {
      return {
        kind: 'failed',
        error: {
          code: 'ffmpeg.encode-failed',
          message: `ffmpeg 抽音失败 (code=${r.code}): ${r.stderr.slice(0, 300)}`,
          retriable: true,
        },
      }
    }

    // ── Step 2: 调 ASR ────────────────────────────────────────
    ctx.reportProgress(25, '提交音频到 ASR（建连）')
    const asr = providers().asr
    let utterances: AsrUtterance[]
    let costCents = 0
    let requestId: string | undefined
    try {
      const out = await asr.transcribe({
        audioPath: wavPath,
        language: project.sourceLang ?? 'zh',
        signal: ctx.signal,
      })
      utterances = out.utterances
      costCents = out.costCents
      requestId = out.requestId
    } catch (err) {
      ctx.logger.error('ASR 调用失败', { err: String((err as any)?.message ?? err) })
      return {
        kind: 'failed',
        error: {
          code: (err as any)?.code ?? 'provider.bad-request',
          message: String((err as any)?.message ?? err),
          retriable: (err as any)?.retriable ?? false,
        },
      }
    }

    ctx.reportProgress(75, `识别得到 ${utterances.length} 句，开始落库`)

    if (costCents > 0) {
      ctx.reportCost({
        projectId: asProjectId(project.id),
        stage: 'asr-diarize',
        provider: 'volcengine',
        model: asr.name,
        units: Math.round((project.sourceDurMs ?? 0) / 1000),
        unitKind: 'seconds',
        cents: costCents,
        requestId,
        ts: Date.now(),
      })
    }

    // ── Step 3: 句段细分（关键！防字幕"一大段挂屏 5 秒"） ──────
    // Volcano 默认返回的 utterance 可能很长（整段对白一句出），
    // 这里按 标点（。！？，；,.!?）+ 时长阈值（>4s）+ 字数阈值（>20）切碎
    const refined = refineUtterances(utterances)
    ctx.logger.info('utterance 细分', {
      before: utterances.length,
      after: refined.length,
    })

    // ── Step 4: 落库 segments + emotion ────────────────────────
    // ★ v0.4.10 过滤脏数据：火山豆包 ASR 对穿插的英语单词常给 startMs=-1
    //   - 这些"卡拉 OK 词级时间戳"在 mix-render 里被当 0ms 处理 → 全部音频叠在开头
    //   - 字幕渲染时同样 0:00:00 开始播 → 画面挤出一堆英文单词
    //   - 客户看图：顶部一字一行的 yo/pero/podría/oh/will/nice/be 就是这个
    //   原则：startMs < 0 或 endMs ≤ startMs 的 segment 直接丢弃
    const filtered = refined.filter((u) => {
      if (u.startMs < 0 || u.endMs <= u.startMs) {
        return false
      }
      return true
    })
    if (filtered.length !== refined.length) {
      ctx.logger.warn('丢弃 ASR 脏 segments（startMs<0 或 endMs<=startMs）', {
        before: refined.length,
        after: filtered.length,
        dropped: refined.length - filtered.length,
        samples: refined
          .filter((u) => u.startMs < 0 || u.endMs <= u.startMs)
          .slice(0, 5)
          .map((u) => ({ startMs: u.startMs, endMs: u.endMs, text: u.text?.slice(0, 30) })),
      })
    }

    SegmentRepo.bulkInsert(
      ctx.projectId as any,
      filtered.map((u, i) => ({
        idx: i,
        startMs: u.startMs,
        endMs: u.endMs,
        speakerId: u.speakerId,
        srcText: u.text,
      })),
    )

    // v0.4.16: 从 demix vocals.wav 切出每段源音，写到 segments.src_audio_path
    // "使用原音"开关启用时，mix-render 用这个文件替 TTS 产物
    if (existsSync(demixVocals)) {
      const srcDir = join(ctx.projectDir, 'stems', 'segments')
      await mkdir(srcDir, { recursive: true })
      const insertPathStmt = db().prepare(
        `UPDATE segments SET src_audio_path = ? WHERE project_id = ? AND idx = ?`,
      )
      for (let i = 0; i < filtered.length; i++) {
        const u = filtered[i]!
        if (u.startMs < 0) continue // 脏数据跳过
        const dur = (u.endMs - u.startMs) / 1000
        if (dur <= 0) continue
        const outPath = join(srcDir, `${i}.wav`)
        // ffmpeg 切 [startMs, dur] 区间，pcm_s16le mono 32kHz（克隆训练格式）
        const r = await runCmd(
          ffmpeg,
          [
            '-y',
            '-i', demixVocals,
            '-ss', String(u.startMs / 1000),
            '-t', String(dur),
            '-ar', '32000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            outPath,
          ],
          { signal: ctx.signal },
        )
        if (r.code === 0 && existsSync(outPath)) {
          insertPathStmt.run(outPath, ctx.projectId, i)
        }
      }
      ctx.logger.info('段原音切片完成', { count: filtered.length, dir: srcDir })
    }
    // emotion 字段单独写回（细分后的 segment 沿用父 utterance 的 emotion）
    const updateEmotion = db().prepare(
      `UPDATE segments SET emotion = ? WHERE project_id = ? AND idx = ?`,
    )
    const tx = db().transaction(() => {
      for (let i = 0; i < filtered.length; i++) {
        const e = filtered[i]?.emotion
        if (e) updateEmotion.run(e, ctx.projectId, i)
      }
    })
    tx()

    // 把 utterance 级 gender 临时存到内存（cluster stage 聚合用）——用细分前的统计更准
    speakerGenderHint.set(ctx.projectId, summarizeGenderBySpeaker(utterances))

    ctx.reportProgress(100, 'ASR 完成')
    return {
      kind: 'ok',
      outputs: {
        utterances: String(utterances.length),
        refined: String(refined.length),
        audio: wavPath,
      },
      durationMs: Date.now() - t0,
    }
  },
}

/**
 * cluster：按 speaker_id 分组建 character。
 * 把火山 ASR 给出的 gender 多数投票聚合到 character.gender。
 */
export const clusterStage: Stage = {
  name: 'cluster',
  version: 2, // v2: 用 ASR 的 gender 投票
  inputsFrom: ['asr-diarize'],
  blocking: true,
  retries: 1,
  kind: 'main',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    ctx.reportProgress(10, '加载 segments')
    const segs = SegmentRepo.list(ctx.projectId as any)
    if (segs.length === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'pipeline.upstream-missing',
          message: '没有 segments，cluster 无法进行',
          retriable: false,
        },
      }
    }

    const bySpeaker = new Map<string, typeof segs>()
    for (const s of segs) {
      const key = s.speakerId ?? 'unknown'
      if (!bySpeaker.has(key)) bySpeaker.set(key, [])
      bySpeaker.get(key)!.push(s)
    }

    ctx.reportProgress(40, `识别到 ${bySpeaker.size} 个说话人`)

    // 视觉辅助拆分：对每个 speaker_id（segments >= 2）调 LLM Vision 判断
    // 是否实际是多个外貌不同的人（比如兄弟脸辨识、长相相近的角色）。
    // 拆完后的 sub-group 在后续步骤里被当成不同的 character。
    const splitMap = new Map<string, { label: string; segIds: Set<string> }[]>()
    for (const [speakerId, ss] of bySpeaker.entries()) {
      if (ss.length < 2) continue // 1 句没必要调 vision
      ctx.reportProgress(
        Math.min(70, 40 + Math.round((20 * Array.from(bySpeaker.keys()).indexOf(speakerId)) / bySpeaker.size)),
        `视觉拆分 speaker=${speakerId}`,
      )
      const split = await trySplitSpeakerByVisual(ctx, speakerId, ss)
      if (split && split.length > 1) {
        ctx.logger.info('视觉拆分：speaker 被拆为多人', {
          speakerId,
          subCount: split.length,
          labels: split.map((g) => g.label),
        })
        splitMap.set(
          speakerId,
          split.map((g) => ({ label: g.label, segIds: new Set(g.segmentIds) })),
        )
      } else if (split && split.length === 1) {
        // v0.4.15 视觉拆分返回 1 组（M3 判断"是同一个人"）→ 也存 label
        // 让 fallback 路径用 M3 描述（"黑发深蓝外套青年"）而不是"角色 1"
        splitMap.set(speakerId, [
          { label: split[0]!.label, segIds: new Set(split[0]!.segmentIds) },
        ])
        ctx.logger.info('视觉拆分：LLM 认为是同一个人，保留 label 给 fallback', {
          speakerId,
          label: split[0]!.label,
        })
      }
    }

    // v0.4.15 第二轮：所有没拿到 label 的 speaker（segments < 2 被跳过、或 M3 判定拆不开）
    // 都补调一次 vision 拿 label，避免 fallback 出现"角色 1"占位
    for (const [speakerId, ss] of bySpeaker.entries()) {
      if (splitMap.has(speakerId)) continue // 已有 label 跳过
      ctx.logger.info('补调 vision 取 label（segments < 2 fallback）', { speakerId, segCount: ss.length })
      const split = await trySplitSpeakerByVisual(ctx, speakerId, ss)
      // 1 组也接受（M3 觉得是同一人、给外观描述就够了）
      if (split && split.length >= 1) {
        const label = split[0]!.label
        splitMap.set(speakerId, [
          { label, segIds: new Set(split[0]!.segmentIds) },
        ])
        ctx.logger.info('补调拿到 label', { speakerId, label })
      }
    }

    CharacterRepo.clearForProject(ctx.projectId as any)

    const genderBySpeaker = speakerGenderHint.get(ctx.projectId) ?? new Map()

    let n = 0
    const characters: Array<{ characterId: string; speakerId: string }> = []
    for (const [speakerId, ss] of bySpeaker.entries()) {
      const inferredGender = genderBySpeaker.get(speakerId) ?? null
      const splitGroups = splitMap.get(speakerId)

      if (splitGroups && splitGroups.length > 1) {
        // 该 speaker 被视觉拆成多个 sub-character
        for (let gi = 0; gi < splitGroups.length; gi++) {
          const grp = splitGroups[gi]!
          const grpSegs = ss.filter((s) => grp.segIds.has(s.id))
          if (grpSegs.length === 0) continue
          const characterId = randomUUID()
          const totalDurMs = grpSegs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0)
          const subSpeakerId = `${speakerId}-${gi}` // 派生 id 让 character.speakerId 唯一
          CharacterRepo.insert({
            id: characterId,
            projectId: ctx.projectId as any,
            name: `角色 ${++n} (${grp.label})`,
            speakerId: subSpeakerId,
            gender: inferredGender,
            ageBand: null,
            sampleScore: Math.min(1, totalDurMs / 30_000),
            sampleDurMs: totalDurMs,
            needsReclone: totalDurMs < 10_000,
          })
          characters.push({ characterId, speakerId: subSpeakerId })
          for (const s of grpSegs) {
            SegmentRepo.patch({ id: s.id, characterId: asCharacterId(characterId) })
            // 同时更新 segment.speaker_id 让后续 stage 一致
            db()
              .prepare('UPDATE segments SET speaker_id = ? WHERE id = ?')
              .run(subSpeakerId, s.id)
          }
        }
      } else {
        // 没拆分：原 speaker = 1 个 character
        // v0.4.15 优先用 M3 视觉描述（"黑发深蓝外套青年"），无 label 时 fallback "角色 N"
        const visLabel = splitGroups?.[0]?.label
        const charName = visLabel
          ? `角色 ${++n} (${visLabel})`
          : `角色 ${++n}`
        const characterId = randomUUID()
        const totalDurMs = ss.reduce((acc, s) => acc + (s.endMs - s.startMs), 0)
        CharacterRepo.insert({
          id: characterId,
          projectId: ctx.projectId as any,
          name: charName,
          speakerId,
          gender: inferredGender,
          ageBand: null,
          sampleScore: Math.min(1, totalDurMs / 30_000),
          sampleDurMs: totalDurMs,
          needsReclone: totalDurMs < 10_000,
        })
        characters.push({ characterId, speakerId })
        for (const s of ss) {
          SegmentRepo.patch({ id: s.id, characterId: asCharacterId(characterId) })
        }
      }
    }

    speakerGenderHint.delete(ctx.projectId) // 用完即清

    ctx.reportProgress(100, `${characters.length} 个角色已创建`)
    return {
      kind: 'ok',
      outputs: { characters: String(characters.length) },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── helpers ─────────────────────────────────────────────────────────

/** ASR 后句段细分的阈值（v0.4.5 回到合理默认）
 *
 * 设计前提澄清（重要！）：
 *   - 客户感知"字幕没切对"的根因是：**ASR 切句节奏 ≠ 原片烧录中文字幕节奏**
 *   - 这两个节奏永远不可能完美一致（原片字幕是人工剪辑、ASR 是机器切）
 *   - v0.4.2/v0.4.5 多次调阈值都无法解决——已停止该路径
 *   - 真正治本方案是 v0.5 上 PaddleOCR sidecar 读原片烧录字幕（用户暂选不做）
 *
 * 当前策略：让 ASR segment 落在"既不太碎、也不太合并"的中庸位置
 * （字幕跟不上中文是接受的事实，但 segment 太长会让单句译文 TTS 拖太久）
 */
const REFINE_CONFIG = {
  maxDurMs: 3_500, // 短剧台词平均时长，3.5s 是常见单句
  maxChars: 18, // 与字幕渲染层 maxCharsPerLine 一致
  minDurMs: 600,
  hardPunct: /[。！？!?]/,
  softPunct: /[，；、,;:]/,
  silenceCutoffMs: 450, // 介于"逗号停顿"和"镜头切换"之间
}

/**
 * 把可能过长的 utterance 按 标点 + 时长 + 字数阈值切碎。
 *
 * 策略：
 *   1. 若 utterance 短（≤ maxDurMs 且 ≤ maxChars）→ 原样保留
 *   2. 若有 words[] 词级时间戳 → 按 words 累积，遇硬标点 / 超长就切
 *   3. 否则按字符等比例切分时间区间（fallback，精度差但能切）
 *
 * 切分后每个 segment 继承父 utterance 的 speakerId / gender / emotion。
 */
const refineUtterances = (utterances: AsrUtterance[]): AsrUtterance[] => {
  const out: AsrUtterance[] = []
  for (const u of utterances) {
    const durMs = u.endMs - u.startMs
    const text = u.text ?? ''
    if (durMs <= REFINE_CONFIG.maxDurMs && text.length <= REFINE_CONFIG.maxChars) {
      out.push(u)
      continue
    }
    // 优先用词级时间戳切
    if (Array.isArray(u.words) && u.words.length > 0) {
      const pieces = splitByWords(u.words, REFINE_CONFIG)
      for (const p of pieces) {
        out.push(inheritUtterance(u, p.startMs, p.endMs, p.text))
      }
    } else {
      // fallback：按字符等比例分配时间
      const pieces = splitByCharsProportional(text, u.startMs, u.endMs, REFINE_CONFIG)
      for (const p of pieces) {
        out.push(inheritUtterance(u, p.startMs, p.endMs, p.text))
      }
    }
  }
  return out
}

interface SplitPiece {
  startMs: number
  endMs: number
  text: string
}

/**
 * 按 word 序列累积，遇硬标点 / 长静音 / 超长就 flush 出一段。
 *
 * v0.4.2 新增 silence-based 切点——中文 ASR 不输出标点，必须靠"词间静音"
 * 作为主要句界信号。详见 isLikelySentenceBoundary。
 */
const splitByWords = (
  words: AsrWord[],
  cfg: typeof REFINE_CONFIG,
): SplitPiece[] => {
  const out: SplitPiece[] = []
  let cur: { startMs: number; endMs: number; chars: string[] } | null = null
  const flush = (): void => {
    if (!cur) return
    const text = cur.chars.join('').trim()
    if (!text) {
      cur = null
      return
    }
    // 太短 → 与上一段合并而不是独立成段
    if (out.length > 0 && cur.endMs - cur.startMs < cfg.minDurMs) {
      const prev = out[out.length - 1]!
      prev.endMs = cur.endMs
      prev.text = (prev.text + text).trim()
    } else {
      out.push({ startMs: cur.startMs, endMs: cur.endMs, text })
    }
    cur = null
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    // —— v0.4.2 静音切点：在加入当前 word **之前**判断是否要先 flush 前一段 ——
    // 注意时序：要"flush 前一段、然后开新段"，不能"加入 word 后再切"，
    // 否则当前 word 会被算到旧段尾部，时间戳就乱了。
    if (cur && i > 0) {
      const prevWord = words[i - 1]!
      if (isLikelySentenceBoundary(prevWord, w, cur, cfg)) {
        flush()
      }
    }

    if (!cur) cur = { startMs: w.startMs, endMs: w.endMs, chars: [] }
    cur.chars.push(w.text)
    cur.endMs = w.endMs

    const curText = cur.chars.join('')
    const curDur = cur.endMs - cur.startMs
    const lastChar = curText[curText.length - 1] ?? ''

    // 切点判断：硬标点直接切；超长 + 软标点切；纯超长（无标点）也切
    if (cfg.hardPunct.test(lastChar)) {
      flush()
    } else if (
      (curDur >= cfg.maxDurMs || curText.length >= cfg.maxChars) &&
      cfg.softPunct.test(lastChar)
    ) {
      flush()
    } else if (curDur >= cfg.maxDurMs * 1.5 || curText.length >= cfg.maxChars * 1.5) {
      // 兜底切：实在太长，没标点也强切
      flush()
    }
  }
  flush()
  return out.length > 0 ? out : []
}

/**
 * 判断「前一个 word 和当前 word 之间的间隙」是不是句界。
 *
 * **这是字幕断句质量的核心**——切得太松（阈值高）= N 句合并的老问题；
 * 切得太紧（阈值低）= 一句话被劈成两半，TTS 重读两个半句很违和。
 *
 * 参数：
 *   - prev: 上一个 word（含 endMs）
 *   - next: 当前 word（含 startMs）
 *   - cur:  当前正在累积的段，含 startMs / endMs / chars
 *   - cfg:  REFINE_CONFIG（含 silenceCutoffMs, minDurMs, maxDurMs, maxChars）
 *
 * 返回 true 时 splitByWords 会在加入 next 之前 flush 当前段。
 *
 * TODO（user implementation）：实现这个函数。5-10 行即可。
 *
 * 推荐起步策略（基础版）：
 *   const gap = next.startMs - prev.endMs
 *   // 当前段累计字数 < 2 或时长 < minDurMs 时不切——避免把"嗯/啊"切成独立段
 *   if (cur.chars.length < 2) return false
 *   if (cur.endMs - cur.startMs < cfg.minDurMs) return false
 *   return gap >= cfg.silenceCutoffMs
 *
 * 可选加强（看效果再决定加哪条）：
 *   - 当前段超过 maxChars × 0.7 时，gap >= 200ms 就切（接近上限时更敏感）
 *   - 当前段刚开始（< 800ms）时，gap 必须 >= 500ms 才切（避免"我"独立成句）
 *   - prev.text 末字符是中文叹词（"啊"/"哦"/"嗯"）时降低阈值（叹词后常是新句）
 *
 * 决策点：是否要"段越长越敏感"（推荐）。短剧节奏快，长段必然合并了多句，
 * 接近 maxChars 时应该把任何 200ms+ 的间隙都视为句界。
 */
const isLikelySentenceBoundary = (
  prev: AsrWord,
  next: AsrWord,
  cur: { startMs: number; endMs: number; chars: string[] },
  cfg: typeof REFINE_CONFIG,
): boolean => {
  // TODO: 实现你的句界判定逻辑
  // 当前是基础版 placeholder——直接用固定阈值，足够把"4 秒 3 句"切开
  const gap = next.startMs - prev.endMs
  if (cur.chars.length < 2) return false
  if (cur.endMs - cur.startMs < cfg.minDurMs) return false
  return gap >= cfg.silenceCutoffMs
}

/** 没有 words 时的兜底：按字符在 [startMs, endMs] 上等比例分配 */
const splitByCharsProportional = (
  text: string,
  startMs: number,
  endMs: number,
  cfg: typeof REFINE_CONFIG,
): SplitPiece[] => {
  if (!text) return []
  const durMs = endMs - startMs
  // 找所有标点位置（按硬标点为主切点；超长且无标点时按 maxChars 强切）
  const points: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (cfg.hardPunct.test(c)) points.push(i + 1)
  }
  // 没硬标点 → 按 maxChars 切
  if (points.length === 0) {
    for (let i = cfg.maxChars; i < text.length; i += cfg.maxChars) points.push(i)
  }
  if (points.length === 0) {
    return [{ startMs, endMs, text }]
  }
  // 末尾收尾
  if (points[points.length - 1] !== text.length) points.push(text.length)

  const out: SplitPiece[] = []
  let prevCharIdx = 0
  for (const p of points) {
    const piece = text.slice(prevCharIdx, p).trim()
    if (piece) {
      const pStartMs = startMs + Math.round((prevCharIdx / text.length) * durMs)
      const pEndMs = startMs + Math.round((p / text.length) * durMs)
      out.push({ startMs: pStartMs, endMs: pEndMs, text: piece })
    }
    prevCharIdx = p
  }
  return out
}

const inheritUtterance = (
  parent: AsrUtterance,
  startMs: number,
  endMs: number,
  text: string,
): AsrUtterance => ({
  startMs,
  endMs,
  text,
  confidence: parent.confidence,
  speakerId: parent.speakerId,
  gender: parent.gender,
  emotion: parent.emotion,
  speechRate: parent.speechRate,
  volume: parent.volume,
  // 不传 words——避免下游误以为还能继续切
})

/**
 * 临时缓存：asr-diarize 把每个 speaker 的 gender 投票存这里，
 * cluster stage 取出来写入 character.gender。
 *
 * 这种 in-memory 跨 stage 通信适合"轻量推断信息"——重要数据走 SQLite。
 * key 是 projectId，值是 speakerId → gender。
 */
const speakerGenderHint = new Map<string, Map<string, 'male' | 'female' | null>>()

/**
 * 按 speaker 聚合 gender 投票——更稳的策略：
 *   1. 只让 ≥ 1500ms 的 utterance 参与投票（短句噪声大，性别识别不可靠）
 *   2. 按 utterance 时长加权（10s 的句子比 2s 的句子更可信）
 *   3. 要求显著优势 ≥ 65%——否则返回 null 让系统兜底走中性
 *
 * 演变原因：demucs 分离后纯人声反而让 Volcano gender_detection 失稳
 * （上一次跑 speaker 0 是 female，这次重跑变 male）。多句加权投票能压低这种噪声。
 */
const summarizeGenderBySpeaker = (
  utterances: AsrUtterance[],
): Map<string, 'male' | 'female' | null> => {
  const MIN_UTTER_MS = 1_500
  const SIGNIFICANCE = 0.65
  const counts = new Map<string, { male: number; female: number; total: number }>()
  for (const u of utterances) {
    if (!u.gender) continue
    const dur = u.endMs - u.startMs
    if (dur < MIN_UTTER_MS) continue
    const c = counts.get(u.speakerId) ?? { male: 0, female: 0, total: 0 }
    c[u.gender] += dur
    c.total += dur
    counts.set(u.speakerId, c)
  }
  const out = new Map<string, 'male' | 'female' | null>()
  for (const [sid, c] of counts.entries()) {
    if (c.total === 0) {
      out.set(sid, null)
      continue
    }
    const maleRatio = c.male / c.total
    const femaleRatio = c.female / c.total
    if (maleRatio >= SIGNIFICANCE) out.set(sid, 'male')
    else if (femaleRatio >= SIGNIFICANCE) out.set(sid, 'female')
    else out.set(sid, null) // 投票不显著 → null，让 TTS 走中性兜底
  }
  return out
}
