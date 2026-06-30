import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult, TtsBaselineGain } from '@dramaprime/core-types'
import { asProjectId, asSegmentId, DEFAULT_TTS_BASELINE } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { db } from '../storage/index.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'

/**
 * v0.2.b tts-synth stage：用 MiniMax Speech-2.8 合成所有句的目标语种音频。
 *
 * 设计要点：
 *   - 角色 voice_id 优先（v0.2.c 之后才有真实克隆），否则按性别/语种推荐系统音色
 *   - 顺序合成（QPS 限制 + 简化错误处理；v0.3 加并发 + rate limit）
 *   - 每句写 tts/<segment_id>.mp3，回填 segments.tgt_audio_path + tgt_dur_ms
 *   - 跳过空译文 / 已锁定的 segment
 */
export const ttsSynthStage: Stage = {
  name: 'tts-synth',
  version: 1,
  inputsFrom: ['translate', 'voice-clone'],
  blocking: true,
  retries: 1,
  kind: 'provider',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const segs = SegmentRepo.list(ctx.projectId as any).filter((s) => s.tgtText && !s.locked)
    if (segs.length === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'pipeline.upstream-missing',
          message: '没有可合成的 segments（缺译文或全部 locked）',
          retriable: false,
        },
      }
    }
    const characters = CharacterRepo.list(ctx.projectId as any)
    const charMap = new Map(characters.map((c) => [c.id, c]))
    // 给每个**回退到系统音色的角色**分配一个稳定的、按 character 顺序的 voice index——
    // 这样即使 4 个男角色全部克隆失败也能拿到 4 个不同的系统音色，不会"两个男声听起来一样"
    const fallbackIdxByCharacter = computeFallbackIndices(characters)
    const tts = providers().tts

    const ttsDir = join(ctx.projectDir, 'tts')
    await mkdir(ttsDir, { recursive: true })

    let totalCents = 0
    let okCount = 0
    let failCount = 0

    for (let i = 0; i < segs.length; i++) {
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
      const s = segs[i]!
      const character = s.characterId ? charMap.get(s.characterId) : null
      const fallbackIdx = character ? fallbackIdxByCharacter.get(character.id) ?? 0 : 0
      // 读用户 override（"我要这一句改成 angry"）—— 优先级高于 ASR 自动推断
      const ov = SegmentRepo.getOverrides(s.id)

      // 短句嘶吼检测：用于参数覆盖（speed/vol/pitch/voice_modify），**不再切换音色**
      // v0.4.7 撤销 voice_id 强制切到 male-qn-badao 的逻辑——客户反馈"中间主角换音色+失真"，
      // 主角整段戏一直是克隆音色 dp_qcwawxiotlyk，到"爸！"突然切到系统音色 = 音色穿帮
      const isShoutShort = isShortShoutSegment(s.srcText ?? '', s.tgtText ?? '')

      // 音色选择（统一路径）：用户覆盖 > 角色克隆音色 > 性别推荐系统音色
      const voiceId =
        ov.userVoiceId ??
        character?.voiceId ??
        pickSystemVoice(character?.gender ?? null, project.targetLang, fallbackIdx)

      // ─── 短句嘶吼路径：参数严格 1:1 复制客户在 MiniMax 官网试听满意的 curl ───
      // 客户官方 curl:
      //   voice_id:    male-qn-badao  ← v0.4.7 撤销强制切换，保留角色克隆音色
      //   speed:       0.5
      //   vol:         10
      //   pitch:       4
      //   emotion:     angry
      //   voice_modify: { pitch: 20, intensity: -50 }
      //   ★ 注意：curl 里**没有** emotion_intensity——与 voice_modify.intensity 同存会失真
      // isShoutShort 已在上面 voiceId 分支判定
      if (isShoutShort) {
        ctx.logger.info('短句嘶吼路径触发，使用客户官方 curl 参数', {
          segId: s.id,
          srcText: s.srcText,
          tgtText: s.tgtText,
          voiceId,
        })
      }
      const effEmotion = isShoutShort
        ? 'angry'
        : (ov.userEmotion ?? s.emotion ?? null)
      // 按情绪调 speed/vol/pitch/intensity——比单传 emotion 字段立体得多
      const tuning = emotionTuning(effEmotion)
      // 叠项目级 baseline——neutral 句也能吃到饱满度
      const baseline = project.config.tts.baselineGain ?? DEFAULT_TTS_BASELINE
      const baseMerged = mergeTuningWithBaseline(tuning, baseline)
      // ★ v0.4.3 标点强度增益：原句 / 译文里有 ！? 时，按数量加码音量 + 强度
      const boostedMerged = boostByPunctuation(baseMerged, s.tgtText ?? '', s.srcText ?? '')
      // 短句嘶吼 → 用客户硬编码参数完全覆盖；其他句子走正常链路
      // v0.4.9 参数更新（客户在 MiniMax 官网试听满意后给的最新 curl）：
      //   speed 0.5→0.6（稍快、避免拖太长显得软）
      //   pitch 4→3（稍降，撕裂感更"沉"）
      //   其他不动：vol=10 (上限), emotion=angry
      const merged = isShoutShort
        ? { speed: 0.6, vol: 10, pitch: 3, intensity: 2.0 }
        : boostedMerged
      const intensity = ov.userIntensity ?? merged.intensity
      const speed = ov.userSpeed ?? merged.speed
      // 在文本里按情绪自动插入停顿标记（MiniMax 语法：<#0.15#>）让节奏更自然
      const enrichedText = enrichTextWithPauses(s.tgtText!, effEmotion)

      try {
        // ★ v0.4.10 限流重试：MiniMax RPM 限流时（错误码 1002）指数退避最多 3 次
        // 客户实测一句报 1002 后，后续所有 segment 连环跳过，整段男声没合成
        // 退避策略：500ms → 1500ms → 4500ms，总等待 < 7s 不影响整体节奏
        const MAX_RETRIES = 3
        const buildTtsParams = () => ({
          model: project.config.tts.model,
          text: enrichedText,
          voiceId,
          format: 'mp3' as const,
          sampleRate: 32_000,
          languageBoost: LANG_BOOST[project.targetLang],
          emotion: effEmotion ?? undefined,
          // emotion_intensity：短句嘶吼时**不传**（与客户 curl 对齐）；其他句子用 boostByPunctuation 算出来的值
          ...(isShoutShort ? {} : { emotionIntensity: intensity }),
          speed,
          vol: merged.vol,
          pitch: merged.pitch,
          // 短句嘶吼用客户最新 curl 的 voice_modify 三字段（pitch + intensity + timbre）
          ...(isShoutShort
            ? { voiceModify: { pitch: 20, intensity: -40, timbre: -20 } }
            : {}),
          signal: ctx.signal,
        })
        let out: Awaited<ReturnType<typeof tts.synthesize>> | null = null
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            out = await tts.synthesize(buildTtsParams())
            break
          } catch (err) {
            const errCode = (err as any)?.code
            const isRateLimit = errCode === 'provider.rate-limited'
            const isLastAttempt = attempt === MAX_RETRIES - 1
            if (!isRateLimit || isLastAttempt) {
              throw err
            }
            // 指数退避：500 → 1500 → 4500 ms
            const backoffMs = 500 * Math.pow(3, attempt)
            ctx.logger.warn(`TTS 触发 RPM 限流，${backoffMs}ms 后重试 ${attempt + 1}/${MAX_RETRIES}`, {
              segId: s.id,
            })
            await new Promise((r) => setTimeout(r, backoffMs))
            if (ctx.signal.aborted) throw err
          }
        }
        if (!out) throw new Error('TTS 重试耗尽')
        // 把 provider 写到 tmpdir 的文件挪到项目目录
        const dst = join(ttsDir, `${s.id}.mp3`)
        const { rename } = await import('node:fs/promises')
        try {
          await rename(out.audioPath, dst)
        } catch {
          // 跨设备 rename 失败 → copy + unlink 兜底
          const { copyFile, unlink } = await import('node:fs/promises')
          await copyFile(out.audioPath, dst)
          await unlink(out.audioPath).catch(() => {})
        }

        // ★ v0.4.7 全句响度归一化（替代 v0.4.7 早版的"嘶吼专用 +6dB"）
        //
        // 背景：实测同项目内不同角色克隆音色响度差 ~10dB（mean -15 到 -25 dB），
        // MiniMax 没做跨克隆音色的响度归一化。客户感觉"主角失真"实为相对响度差。
        //
        // 方案：所有 TTS 句子用 ffmpeg loudnorm 拉到 -16 LUFS：
        //   - I=-16 LUFS：目标响度（流媒体短剧常用，比电视广播 -23 LUFS 更响）
        //   - LRA=11：动态范围（保留情绪强弱对比，不一味压扁）
        //   - TP=-1.5 dBTP：True Peak 上限，避免削顶失真
        // 失败不阻断流水线，保留原音频
        await normalizeLoudness(dst, ctx).catch((err) => {
          ctx.logger.warn('响度归一化失败，保留原音频', {
            segId: s.id,
            err: String((err as any)?.message ?? err),
          })
        })

        db()
          .prepare(`UPDATE segments SET tgt_audio_path = ?, tgt_dur_ms = ? WHERE id = ?`)
          .run(dst, out.durationMs, s.id)
        // 落 TTS 快照——让"工作台"能展示这一句用了啥参数
        SegmentRepo.setTtsSnapshot(s.id, {
          inputText: enrichedText,
          voiceId,
          emotion: effEmotion,
          intensity,
          speed,
          vol: merged.vol,
          pitch: merged.pitch,
        })
        totalCents += out.costCents
        okCount++
      } catch (err) {
        ctx.logger.warn('tts 单句失败，跳过', {
          segId: s.id,
          err: String((err as any)?.message ?? err),
        })
        failCount++
      }

      ctx.reportProgress(
        Math.round(((i + 1) / segs.length) * 95),
        `TTS ${i + 1}/${segs.length}（成功 ${okCount} 失败 ${failCount}）`,
      )

      // v0.4.10 段间 throttle 防限流：MiniMax RPM 限制不明确，60-80 RPM 比较安全
      // 每句间隔 200ms = 最大 5 RPS = 300 RPM，留余量；首尾不加
      if (i < segs.length - 1 && !ctx.signal.aborted) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    if (totalCents > 0) {
      ctx.reportCost({
        projectId: asProjectId(project.id),
        stage: 'tts-synth',
        provider: 'MiniMax',
        model: project.config.tts.model,
        units: segs.reduce((acc, s) => acc + (s.tgtText?.length ?? 0), 0),
        unitKind: 'chars',
        cents: totalCents,
        ts: Date.now(),
      })
    }

    ctx.reportProgress(100, `TTS 完成 ${okCount}/${segs.length}`)
    if (okCount === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'provider.bad-request',
          message: '所有句的 TTS 合成都失败',
          retriable: true,
        },
      }
    }
    return {
      kind: 'ok',
      outputs: { ok: String(okCount), failed: String(failCount) },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── 系统音色推荐表 ──────────────────────────────────────────────────
// 没真实克隆时按 gender + 语种回退到这些
// MiniMax 文档列表里精选最常用、跨语种泛化好的几个
// **多个**音色是为了让"多角色克隆全失败"时 fallback 仍能区分不同 character
const SYSTEM_VOICES_MALE = [
  'male-qn-jingying',
  'male-qn-qingse',
  'male-qn-badao',
  'presenter_male',
  'audiobook_male_1',
  'audiobook_male_2',
]
const SYSTEM_VOICES_FEMALE = [
  'female-shaonv',
  'female-tianmei',
  'female-yujie',
  'female-chengshu',
  'presenter_female',
  'audiobook_female_1',
]
const SYSTEM_VOICES_NEUTRAL = [
  'presenter_male',
  'presenter_female',
  'audiobook_male_2',
  'audiobook_female_2',
]

/**
 * 按性别 + character 在项目里的相对顺序选一个系统音色。
 * 同性别多个角色会拿到不同的 voice_id（modulo 池大小），
 * 这样"克隆全失败也至少角色之间有区分度"。
 */
const pickSystemVoice = (
  gender: string | null,
  _targetLang: string,
  fallbackIdx: number,
): string => {
  if (gender === 'male') return SYSTEM_VOICES_MALE[fallbackIdx % SYSTEM_VOICES_MALE.length]!
  if (gender === 'female') return SYSTEM_VOICES_FEMALE[fallbackIdx % SYSTEM_VOICES_FEMALE.length]!
  return SYSTEM_VOICES_NEUTRAL[fallbackIdx % SYSTEM_VOICES_NEUTRAL.length]!
}

/**
 * 按 gender 分组后给每个 character 一个 0-based 的"组内序号"。
 * 用作 pickSystemVoice 的 fallbackIdx，让相同性别的 N 个角色拿到不同系统音色。
 */
const computeFallbackIndices = (
  characters: Array<{ id: string; gender: string | null; speakerId: string }>,
): Map<string, number> => {
  const out = new Map<string, number>()
  const counters: Record<string, number> = { male: 0, female: 0, _: 0 }
  // 按 speaker_id 排序保证稳定（重跑也是相同顺序）
  const sorted = [...characters].sort((a, b) =>
    (a.speakerId ?? '').localeCompare(b.speakerId ?? ''),
  )
  for (const c of sorted) {
    const bucket = c.gender === 'male' ? 'male' : c.gender === 'female' ? 'female' : '_'
    out.set(c.id, counters[bucket]!)
    counters[bucket] = (counters[bucket] ?? 0) + 1
  }
  return out
}

// MiniMax language_boost 参数（小语种音色稳定性）
const LANG_BOOST: Record<string, string> = {
  yue: 'Chinese,Yue',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ar: 'Arabic',
  hi: 'Hindi',
}

// ─── 情绪 → 参数调优表（短剧 dubbing 经验值） ─────────────────────────
/**
 * 不同情绪对 TTS 参数的微调建议。
 *
 *   - intensity: MiniMax emotion_intensity（0.5-2.0），>1 让情绪更夸张饱满
 *   - speed: 语速倍率（0.5-2.0），愤怒/惊讶快、悲伤慢
 *   - vol: 音量倍率（0-10），愤怒响、悲伤轻
 *   - pitch: 半音偏移（-12 ~ +12），惊讶上扬、悲伤下沉
 *
 * 经验来源：行业 dubbing 配音指导 + MiniMax 文档建议范围；保守取值避免变声。
 */
interface EmotionTuning {
  intensity: number
  speed: number
  vol: number
  pitch: number
}

const EMOTION_TUNING: Record<string, EmotionTuning> = {
  // 短剧 dubbing 安全范围：intensity 1.2-1.4（够饱满又不夸张），
  // speed ±5% 内（人耳不易察觉变速），pitch ±1 半音（不变声）
  angry: { intensity: 1.4, speed: 1.03, vol: 1.1, pitch: 1 },
  happy: { intensity: 1.3, speed: 1.03, vol: 1.05, pitch: 1 },
  sad: { intensity: 1.3, speed: 0.95, vol: 0.9, pitch: -1 },
  surprised: { intensity: 1.4, speed: 1.05, vol: 1.05, pitch: 1 },
  fearful: { intensity: 1.3, speed: 1.03, vol: 0.95, pitch: 0 },
  disgusted: { intensity: 1.3, speed: 0.98, vol: 1.0, pitch: 0 },
  neutral: { intensity: 1.0, speed: 1.0, vol: 1.0, pitch: 0 },
}

const emotionTuning = (raw: string | null | undefined): EmotionTuning => {
  if (!raw) return EMOTION_TUNING.neutral!
  // raw 可能是 Volcano 原始值（surprise / fear / disgust），先 map 再查表
  const key = raw.trim().toLowerCase()
  const mapped =
    key === 'surprise' ? 'surprised' :
    key === 'fear' ? 'fearful' :
    key === 'disgust' ? 'disgusted' :
    key
  return EMOTION_TUNING[mapped] ?? EMOTION_TUNING.neutral!
}

// ─── baseline 合并逻辑（用户实现） ──────────────────────────────────────
/**
 * 把 emotion tuning 和项目级 baseline 合并成最终调用 TTS 的参数。
 *
 * **这是产品调性的核心决策**——同样的输入有 3 种合理合法：
 *
 *   策略 A · 乘性叠加（推荐起步）：
 *     vol       = emotion.vol × baseline.vol      e.g. 1.1 × 1.15 = 1.265
 *     intensity = emotion.intensity + (baseline.intensity - 1)  e.g. 1.3 + 0.15 = 1.45
 *     pitch     = emotion.pitch + baseline.pitch  e.g. 1 + 0 = 1
 *     speed     = emotion.speed                   保持不动（baseline 不调语速）
 *   优点：emotion 1.0×baseline 1.15 = 1.15（baseline 起效），
 *         emotion 1.4×baseline 1.15 = 1.61（情绪 + baseline 都起效）
 *   缺点：高情绪 × 高 baseline 可能超 MiniMax 上限（intensity 上限 2.0）
 *
 *   策略 B · 加性叠加：
 *     vol = emotion.vol + (baseline.vol - 1)
 *   缺点：vol 1.1 + 0.15 = 1.25 vs 乘性的 1.265，差异微小
 *
 *   策略 C · 取 max：
 *     vol = max(emotion.vol, baseline.vol)
 *   缺点：高情绪句子的 vol 1.1 被 baseline 1.15 覆盖 → 情绪削弱
 *
 * **clamp 约束**（必须做）：
 *   - vol 上限 2.0（MiniMax 接受 0-10 但 >2 容易削顶/失真）
 *   - intensity 范围 [0.5, 2.0]（MiniMax 硬约束，超出会被 provider 拒绝）
 *   - pitch 范围 [-12, +12]（MiniMax 硬约束）
 *
 * **请你实现下面这个函数**——5-10 行就够。建议选策略 A 起步，
 * 跑一遍样片听感不饱满再调 baseline 数值（而不是改合并策略）。
 *
 * 参考实现骨架：
 *   const vol       = clamp(e.vol * b.vol, 0, 2.0)
 *   const intensity = clamp(e.intensity + (b.intensity - 1), 0.5, 2.0)
 *   const pitch     = clamp(e.pitch + b.pitch, -12, 12)
 *   return { intensity, speed: e.speed, vol, pitch }
 */
const mergeTuningWithBaseline = (
  e: EmotionTuning,
  b: TtsBaselineGain,
): EmotionTuning => {
  // 策略 A 乘性叠加：baseline 在 emotion 之上加码
  // v0.4.4: vol clamp 上限放宽 2.0 → 5.0
  //   - MiniMax 真实接受 [0, 10]，2.0 是我之前过度保守
  //   - 客户反馈"声音绵软"+"撕心裂肺"诉求 → 头部空间必须够
  return {
    intensity: Math.max(0.5, Math.min(2.0, e.intensity + (b.intensity - 1))),
    speed: e.speed,
    vol: Math.max(0, Math.min(5.0, e.vol * b.vol)),
    pitch: Math.max(-12, Math.min(12, e.pitch + b.pitch)),
  }
}

/**
 * v0.4.3 新增：按句子里的感叹号 / 问号数量额外加码 vol + intensity。
 *
 * 设计原理：
 *   - LLM 翻译已经把感叹号传给我们了——白送的"强语气"信号
 *   - emotion 字段只标到 angry/happy 级别，但同样 happy 的两句里，
 *     "好的"（陈述）和"太棒了！！"（呼喊）应该重读 + 大音量区分
 *   - 标点数量是粗暴但稳健的量化：1 个 ! = 提一档，2 个以上 = 提两档
 *
 * v0.4.4 修复："爸！" 这种**短句独立呼喊**被低估
 *   - "爸！" 只有 1 个 ! 按旧规则只 ×1.1，但戏剧上是爆发呼喊
 *   - 短句（≤ 4 字）+ 标点 → 视作"独立呼喊"，按 2+ 档处理
 *   - 实测短剧里"妈！/哥！/啊！/不！"出现率高、能量大，单独优化值得
 *
 * 优先级：先看 tgt 译文（这是 TTS 真正读的内容），fallback 看 src 原文
 *
 * 增益规则（v0.4.4）：
 *   - 0 个 ! ?            → 原样返回
 *   - 短句呼喊（≤4字 + !）→ vol ×1.35、intensity +0.3（最强档）
 *   - 1 个标点           → vol ×1.10、intensity +0.10
 *   - 2 个+ 标点          → vol ×1.20、intensity +0.20
 *
 * 与 baseline / emotion 的关系：乘加之后再 clamp，保证不超 MiniMax 接受区间。
 */
const boostByPunctuation = (
  base: EmotionTuning,
  tgtText: string,
  srcText: string,
): EmotionTuning => {
  // 半角 + 全角的 ! ? 都算
  const PUNCT = /[!！?？]/g
  const tgtCount = (tgtText.match(PUNCT) ?? []).length
  const srcCount = (srcText.match(PUNCT) ?? []).length
  const n = tgtCount > 0 ? tgtCount : srcCount
  if (n === 0) return base

  // ★ 短句呼喊检测：原文 / 译文任一只要"足够短 + 含标点" → 视为爆发呼喊
  // 用 srcText 长度而不是 tgtText 长度——译文可能因目标语言扩展（"爸！"→"Ayah!"）变长
  // 短句长度阈值用"非标点字符数"判断，避免"！！！"扩到 4 个标点逃过短句判定
  const srcCore = srcText.replace(PUNCT, '').trim()
  const isShoutShort = srcCore.length > 0 && srcCore.length <= 4
  if (isShoutShort) {
    // v0.4.4 "撕心裂肺"档 —— MiniMax 真实参数边界：
    //   vol [0, 10]、intensity [0.5, 2.0]、pitch [-12, +12]
    //   之前 vol×1.35 = 1.755 还是"温和"——客户反馈"绵软无力"
    //   现在直接拉到 MiniMax 接受值的中段：
    //     vol  ×2.2     → "爸！"在 baseline 1.3 下变 1.3×2.2 = 2.86（仍远低于上限 10）
    //     intensity +0.55 → 短句独立爆发应当接近 intensity 上限 2.0
    //     pitch +3      → 短促呼喊的高音特征（影视配音经验：喊叫 = vol↑ + pitch↑↑）
    return {
      intensity: Math.max(0.5, Math.min(2.0, base.intensity + 0.55)),
      speed: base.speed,
      vol: Math.max(0, Math.min(10.0, base.vol * 2.2)), // ⚠️ 上限改为 10（MiniMax 真实接受值）
      pitch: Math.max(-12, Math.min(12, base.pitch + 3)),
    }
  }

  // 普通长句：1 个 → 一档；2+ → 两档（不再继续加，避免 "！！！！" 撑爆）
  // v0.4.4: vol 上限从 2.0 放宽到 5.0（MiniMax 真实接受 [0, 10]）
  const volMul = n >= 2 ? 1.35 : 1.2  // 之前 1.2/1.1 → 1.35/1.2
  const intensityDelta = n >= 2 ? 0.3 : 0.2 // 之前 0.2/0.1 → 0.3/0.2
  return {
    intensity: Math.max(0.5, Math.min(2.0, base.intensity + intensityDelta)),
    speed: base.speed,
    vol: Math.max(0, Math.min(5.0, base.vol * volMul)),
    pitch: base.pitch,
  }
}

/**
 * v0.4.5 短句嘶吼检测 ——
 *
 * 触发条件：原文非标点字符数 ≤ 4 且含 ! / ?。匹配"爸！"/"啊！"/"不！"/"放屁！"这类爆发呼喊。
 *
 * 触发后 tts-stage 主流程会**绕过所有 baseline/merge/boost 链路**，
 * 直接用客户硬性规定的参数：
 *   speed=0.5, vol=10, pitch=4, emotion=angry, intensity=2.0
 *
 * 用 srcText 长度而不是 tgtText（译文可能因目标语言扩展变长，如 "爸！"→"Ayah!"）。
 */
const isShortShoutSegment = (srcText: string, _tgtText: string): boolean => {
  if (!srcText) return false
  const PUNCT = /[!！?？]/g
  if (!PUNCT.test(srcText)) return false
  const srcCore = srcText.replace(PUNCT, '').trim()
  return srcCore.length > 0 && srcCore.length <= 4
}

// ─── 按情绪自动插入 MiniMax 停顿标记（喘息感） ────────────────────────
/**
 * 在合适位置插入 MiniMax `<#0.15#>` 极轻停顿。
 *
 * **设计原则**：MiniMax 自己看到 `。！？` 就会有自然停顿，这里只是**微调**——
 * sad / surprised 戏需要稍多一点"消化时间"，其它情绪不动。
 *
 * **关键约束**：单句额外停顿总和 ≤ 0.3s——超过会撑大 segment 时长导致 align 拉伸失真。
 * 不在逗号 / 分号后加（它们已经有自然停顿，再加就过头）。
 */
const enrichTextWithPauses = (text: string, emotion: string | null | undefined): string => {
  if (!text) return text
  const e = (emotion ?? '').trim().toLowerCase()
  // 已经有 <#...#> 标记的（比如调用方手动加了）就别动
  if (/<#\d/.test(text)) return text

  // 只 sad / surprised 给一个极轻句末停顿；其它情绪保持 MiniMax 原生节奏
  let hardPause = 0
  if (e === 'sad') hardPause = 0.15
  else if (e === 'surprised' || e === 'surprise') hardPause = 0.15

  if (hardPause === 0) return text

  // 只在**第一个**句末标点后加（避免一句多个句号都加导致总停顿超 0.3s）
  // 末尾标点 / 单独句子不加（不需要前向衔接）
  let added = false
  return text.replace(/([。！？!?])(?=\s*\S)/g, (m) => {
    if (added) return m
    added = true
    return `${m}<#${hardPause.toFixed(2)}#>`
  })
}

/**
 * v0.4.7 全句响度归一化 —— 先测量 mean_volume，再用 volume 增益补差到目标响度。
 *
 * 为什么需要：
 *   - 实测同项目内不同克隆音色 mean_volume 差 ~10dB（-15dB 到 -25dB）
 *   - 客户感知"主角失真"实为主角段落相对其他段落削顶感强（相对响度差）
 *   - 不同 voice_id 训练样本能量差异天然存在，MiniMax 不做跨音色归一化
 *
 * 为什么不用 loudnorm（EBU R128）：
 *   - loudnorm 按 LUFS 积分响度测量，对短句（300-600ms）误判严重
 *   - 离线实测 -25.8dB 输入 → loudnorm 单次模式输出 -35.5dB（反向压低 10dB！）
 *   - 两次扫描模式准确但慢 2x，且对极短句仍不稳定
 *
 * 为什么不用 dynaudnorm（滑动窗口）：
 *   - dynaudnorm 针对**句内动态**做归一，不归一句间相对响度
 *   - 离线实测跨句方差仍 ~10dB（与原始一致），没解决相对响度问题
 *
 * 方案：先 volumedetect 测 mean_volume，再 volume=NdB 补差到 -18 dBFS
 *   - 目标 -18 dBFS：客户感觉够响 + max 留 1-2 dB 削顶缓冲
 *   - 离线实测：3 句跨度 -15.6/-21.6/-25.8 → 归一到 -16.5/-16.4/-16.8（0.4dB 方差，完美）
 *   - 每句 +200ms ffmpeg 调用（先测后补，两次轻量调用）
 *
 * 失败抛错由调用方 catch 后保留原音频，不阻断流水线
 */
const normalizeLoudness = async (
  mp3Path: string,
  ctx: StageRunContext,
): Promise<void> => {
  const ffmpeg = requireFfmpeg()

  // Step 1: 测量 mean_volume
  const measureResult = await runCmd(
    ffmpeg,
    ['-i', mp3Path, '-af', 'volumedetect', '-f', 'null', '-'],
    { signal: ctx.signal },
  )
  // volumedetect 把信息写到 stderr，code 是 0 是正常完成
  if (measureResult.code !== 0) {
    throw new Error(`ffmpeg volumedetect 失败 code=${measureResult.code}`)
  }
  const meanMatch = measureResult.stderr.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/)
  if (!meanMatch?.[1]) {
    throw new Error(`无法从 ffmpeg 输出解析 mean_volume`)
  }
  const meanDb = parseFloat(meanMatch[1])
  // 目标 -18 dBFS：客户感知够响 + 留削顶缓冲；clamp [-12, +12] 避免极端值
  const TARGET_DB = -18
  const gainDb = Math.max(-12, Math.min(12, TARGET_DB - meanDb))

  // Step 2: 应用增益
  const tmpPath = mp3Path.replace(/\.mp3$/, '.normalized.mp3')
  const applyResult = await runCmd(
    ffmpeg,
    [
      '-y',
      '-i',
      mp3Path,
      '-af',
      `volume=${gainDb.toFixed(2)}dB`,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      tmpPath,
    ],
    { signal: ctx.signal },
  )
  if (applyResult.code !== 0) {
    throw new Error(`ffmpeg volume 失败 code=${applyResult.code}: ${applyResult.stderr.slice(0, 200)}`)
  }
  // 原地覆盖
  const { rename, unlink } = await import('node:fs/promises')
  await unlink(mp3Path).catch(() => {})
  await rename(tmpPath, mp3Path)
}
