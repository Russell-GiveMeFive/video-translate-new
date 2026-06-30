import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult } from '@dramaprime/core-types'
import { asCharacterId, asProjectId } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { VoiceAssetRepo } from '../storage/voice-asset-repo.js'  // v0.4.12 跨项目音色库
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'
import { recloneExtended } from '../orchestrator/reclone-extended.js'  // v0.4.19 失败/跳过自动 fallback

/**
 * v0.2.c voice-clone：为每个角色提取克隆样本 + 调 MiniMax 三步走拿 voice_id。
 *
 *   - 暂时直接从源视频按 segment 时间戳裁音频（v0.3 demix 真实化后改读 vocals.wav）
 *   - 评分：sample_score（cluster 阶段已写）；< 10s 跳过克隆走系统音色（D3）
 *   - 跨集复用：v0.3 实现"音色资产库"匹配
 */
export const voiceCloneStage: Stage = {
  name: 'voice-clone',
  version: 1,
  inputsFrom: ['cluster'],
  blocking: false, // 失败不阻塞 tts（tts 会用系统音色兜底）
  retries: 1,
  kind: 'provider',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const characters = CharacterRepo.list(ctx.projectId as any)
    if (characters.length === 0) {
      return { kind: 'skipped', reason: '没有角色，跳过克隆' }
    }
    if (!existsSync(project.sourcePath)) {
      return {
        kind: 'failed',
        error: {
          code: 'user.file-not-found',
          message: `源视频不存在：${project.sourcePath}`,
          retriable: false,
        },
      }
    }
    const ffmpeg = requireFfmpeg()
    const voicesDir = join(ctx.projectDir, 'voices')
    await mkdir(voicesDir, { recursive: true })
    const clone = providers().clone

    // 优先从 demix 产物 vocals.wav 裁样本（纯人声，克隆质量大幅提升）；没有则源视频兜底
    const demixVocals = join(ctx.projectDir, 'stems', 'vocals.wav')
    const sampleSourcePath = existsSync(demixVocals) ? demixVocals : project.sourcePath
    ctx.logger.info('克隆样本输入源', {
      useVocals: sampleSourcePath === demixVocals,
      sampleSourcePath,
    })

    let okCount = 0
    let skippedCount = 0
    let failedCount = 0
    let fallbackOkCount = 0   // v0.4.19 自动 reclone-extended 成功数
    let fallbackFailCount = 0 // v0.4.19 自动 reclone-extended 也失败数

    for (let ci = 0; ci < characters.length; ci++) {
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
      const c = characters[ci]!
      ctx.reportProgress(
        Math.round((ci / characters.length) * 90),
        `克隆 ${c.name ?? c.speakerId}`,
      )

      // 取该角色所有 segment（已经按时间排好）
      const segs = SegmentRepo.list(ctx.projectId as any).filter(
        (s) => s.characterId === c.id,
      )
      if (segs.length === 0) {
        skippedCount++
        continue
      }
      // **只**用该 character 自己的 segments 拼接克隆样本——绝不跨人段连续裁
      // （之前的 bug：pickBestSampleRange 取"该 character 时间区间"，里面混了其他人的对白）
      const totalDurMs = segs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0)
      // v0.4.22: 门槛从 2500ms 降到 500ms。短样本走 stream_loop 无缝循环到 10.5s+ 也能克隆，
      //         比所有男角色都用同一系统音色（如 male-qn-qingse）强。
      //         500ms 是绝对底线 —— 比这个短的多半是噪声/语气词，循环再多也学不到稳定音色特征。
      const MIN_SAMPLE_MS = 500
      const MINIMAX_MIN_UPLOAD_MS = 10_500 // MiniMax 文档要求 ≥ 10s，留 500ms 余量
      if (totalDurMs < MIN_SAMPLE_MS) {
        ctx.logger.info('角色样本不足 500ms，尝试 fallback: reclone-extended', {
          characterId: c.id,
          totalDurMs,
          segCount: segs.length,
        })
        // v0.4.19 自动 fallback：拼接 src_audio_path → 循环到 10.5s+ → upload+clone
        if (await tryFallbackReclone(ctx, c.id, '样本 < 500ms')) {
          fallbackOkCount++
        } else {
          fallbackFailCount++
          skippedCount++
        }
        continue
      }
      const needsPadding = totalDurMs < MINIMAX_MIN_UPLOAD_MS
      if (needsPadding) {
        ctx.logger.warn('角色样本不足 10s，将循环复制本人样本到 10.5s+ 上传', {
          characterId: c.id,
          totalDurMs,
          targetMs: MINIMAX_MIN_UPLOAD_MS,
        })
      }
      // 限制最长 60s 避免上传超 MiniMax 20MB 限制；按顺序累计到 60s 即可
      const SAMPLE_BUDGET_MS = 60_000
      const usedSegs: typeof segs = []
      let usedMs = 0
      for (const s of segs) {
        const dur = s.endMs - s.startMs
        if (usedMs + dur > SAMPLE_BUDGET_MS && usedMs >= 30_000) break
        usedSegs.push(s)
        usedMs += dur
        if (usedMs >= SAMPLE_BUDGET_MS) break
      }
      ctx.logger.info('克隆样本片段', {
        characterId: c.id,
        segCount: usedSegs.length,
        totalMs: usedMs,
      })

      // 裁出基础样本：用 filter_complex 把每个 segment 单独 trim 后无缝 concat
      // 保证样本里**只有该角色自己的声音**，且段与段之间无静音 gap
      // 若不足 10.5s，下一步用 stream_loop 把整段无缝循环复制到 10.5s+
      // v0.4.20: 删掉 100ms 静音 gap —— MiniMax 会把静音学成"说话间隔"特征，导致音色发闷
      const baseSamplePath = join(voicesDir, `${c.id}-base.wav`)
      const samplePath = join(voicesDir, `${c.id}-sample.mp3`)
      const filterScript = buildSampleConcatFilter(usedSegs)
      const filterScriptPath = join(voicesDir, `${c.id}-sample-filter.txt`)
      await writeFile(filterScriptPath, filterScript, 'utf-8')
      // 第一步：拼基础样本到 wav（pcm 方便后面 stream_loop）
      let r = await runCmd(
        ffmpeg,
        [
          '-i', sampleSourcePath,
          '-filter_complex_script', filterScriptPath,
          '-map', '[outa]',
          '-c:a', 'pcm_s16le',
          '-ar', '32000',
          '-ac', '1',
          '-y',
          baseSamplePath,
        ],
        { signal: ctx.signal },
      )
      if (r.code !== 0 || !existsSync(baseSamplePath)) {
        ctx.logger.warn('基础样本拼接失败，尝试 fallback: reclone-extended', { characterId: c.id, stderr: r.stderr.slice(0, 200) })
        if (await tryFallbackReclone(ctx, c.id, '基础样本拼接失败')) {
          fallbackOkCount++
        } else {
          fallbackFailCount++
          failedCount++
        }
        continue
      }
      // 第二步：若 < 10.5s，stream_loop 把基础样本整段无缝复制到 10.5s+
      if (needsPadding) {
        r = await runCmd(
          ffmpeg,
          [
            '-stream_loop', '-1',          // 无限循环输入
            '-i', baseSamplePath,
            '-t', String(MINIMAX_MIN_UPLOAD_MS / 1000),  // 截到目标长度
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            '-ar', '32000',
            '-ac', '1',
            '-y',
            samplePath,
          ],
          { signal: ctx.signal },
        )
      } else {
        // 已经够长，直接转 mp3
        r = await runCmd(
          ffmpeg,
          [
            '-i', baseSamplePath,
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            '-ar', '32000',
            '-ac', '1',
            '-y',
            samplePath,
          ],
          { signal: ctx.signal },
        )
      }
      if (r.code !== 0 || !existsSync(samplePath)) {
        ctx.logger.warn('样本裁切失败，尝试 fallback: reclone-extended', { characterId: c.id, stderr: r.stderr.slice(0, 200) })
        if (await tryFallbackReclone(ctx, c.id, '样本裁切失败')) {
          fallbackOkCount++
        } else {
          fallbackFailCount++
          failedCount++
        }
        continue
      }
      // 文件大小检查（MiniMax 限制 ≤ 20MB；32k mono 128kbps 大概 1MB/min，60s 无忧）
      const size = statSync(samplePath).size
      if (size > 19 * 1024 * 1024) {
        ctx.logger.warn('样本超 19MB，尝试 fallback: reclone-extended', { characterId: c.id, size })
        if (await tryFallbackReclone(ctx, c.id, '样本 > 19MB')) {
          fallbackOkCount++
        } else {
          fallbackFailCount++
          failedCount++
        }
        continue
      }

      CharacterRepo.setSample(asCharacterId(c.id), samplePath, c.sampleScore ?? undefined)

      // 三步走：upload → clone → 记录 voice_id（不立刻 promote，留到 TTS 首次使用时自然 promote）
      try {
        const up = await clone.upload(samplePath, ctx.signal)
        const cloned = await clone.clone({
          fileId: up.fileId,
          model: project.config.tts.model,
          signal: ctx.signal,
        })
        CharacterRepo.setVoice(asCharacterId(c.id), {
          voiceId: cloned.voiceId,
          voiceStatus: 'temp',
          voiceExpiresAt: cloned.expiresAt,
        })
        // v0.4.12 跨项目音色库：复刻成功后记录到 voice_assets
        // 用户在 voices 页面能看到这个 voice_id 来自哪个项目、对应哪个角色
        VoiceAssetRepo.record({
          voiceId: cloned.voiceId as any,
          defaultName: c.name ?? '未命名角色',   // 用户可在 voices 页面改
          originProjectId: project.id,
          originCharacterName: c.name ?? '未命名角色',
        })
        okCount++
        ctx.logger.info('克隆成功', { characterId: c.id, voiceId: cloned.voiceId })
      } catch (err) {
        ctx.logger.warn('克隆失败，尝试 fallback: reclone-extended', {
          characterId: c.id,
          err: String((err as any)?.message ?? err),
        })
        if (await tryFallbackReclone(ctx, c.id, 'MiniMax clone 抛错')) {
          fallbackOkCount++
        } else {
          fallbackFailCount++
          failedCount++
        }
      }
    }

    // MiniMax 文档：voice clone 本身不收费；首次使用时计费。这里不上报 cost
    ctx.reportProgress(
      100,
      `克隆完成 OK=${okCount}(+fb${fallbackOkCount}) 跳过=${skippedCount} 失败=${failedCount}`,
    )
    return {
      kind: 'ok',
      outputs: {
        ok: String(okCount),
        skipped: String(skippedCount),
        failed: String(failedCount),
        fallbackOk: String(fallbackOkCount),
        fallbackFail: String(fallbackFailCount),
      },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * v0.4.19 自动 fallback：常规克隆 skipped/failed 时，调用 reclone-extended 二次尝试。
 *
 * 调用语义：返回 true 代表 fallback 成功（角色已拿到 voice_id）；
 *           返回 false 代表 fallback 也失败（角色仍走系统音色兜底）。
 *
 * ★ 关键决策点（v0.4.19 留给产品定夺）：什么时候**直接放弃 fallback**？
 *   reclone-extended 会做 ffmpeg 拼接 + 上传 + clone，最坏情况几十秒。
 *   如果有些场景注定失败，提前 short-circuit 能省时间。
 *
 *   TODO: 在 shouldSkipFallback 里实现"什么样的 character/segs 组合不值得 fallback"。
 *         决策维度可参考：
 *           - 角色总 src_audio_path 文件存在数（recloneExtended 内部也会校验，但提前判更省）
 *           - 已经 fallback 过的角色（防止 stage 被 retry 时重复 fallback）
 *           - sampleScore 极低（可能根本不是稳定说话人）
 *           - 角色 segments 数 < N（短到不值得克隆）
 */
async function tryFallbackReclone(
  ctx: StageRunContext,
  characterId: string,
  reason: string,
): Promise<boolean> {
  if (ctx.signal.aborted) return false

  if (shouldSkipFallback(ctx, characterId)) {
    ctx.logger.info('fallback 被 shouldSkipFallback 跳过', { characterId, reason })
    return false
  }

  try {
    const r = await recloneExtended(characterId, ctx.projectId as any)
    ctx.logger.info('fallback reclone-extended 成功', {
      characterId,
      reason,
      voiceId: r.voiceId,
      sourceCount: r.sourceCount,
    })
    return true
  } catch (err) {
    ctx.logger.warn('fallback reclone-extended 失败', {
      characterId,
      reason,
      err: String((err as any)?.message ?? err),
    })
    return false
  }
}

/**
 * v0.4.19 fallback 前置过滤：返回 true 代表该角色不值得 fallback，直接走系统音色。
 *
 * 策略（保守派）：要求 srcAudioPath 真实存在文件 ≥ 2 个 + 累计存在文件时长 ≥ 1500ms 才 fallback。
 * 理由：低于这个量级 reclone-extended 的 aloop 会把单段循环复制 7+ 次，
 *       克隆出来音色有明显"回响感"，质量不如系统音色稳定。
 *
 * 信号来源：
 *   - segs[i].srcAudioPath 是 asr-diarize 阶段切出的"该角色单独说话"小 wav，比 vocals.wav 干净
 *   - sampleScore 来自 cluster 阶段，目前 < 2 段就基本聚不出可靠 score，所以这里不再用
 */
function shouldSkipFallback(ctx: StageRunContext, characterId: string): boolean {
  const MIN_FILES = 2
  const MIN_TOTAL_MS = 1500
  const segs = SegmentRepo.list(ctx.projectId as any).filter((s) => s.characterId === characterId)
  const validSegs = segs.filter((s) => s.srcAudioPath && existsSync(s.srcAudioPath))
  const totalMs = validSegs.reduce((acc, s) => acc + (s.endMs - s.startMs), 0)
  const skip = validSegs.length < MIN_FILES || totalMs < MIN_TOTAL_MS
  if (skip) {
    ctx.logger.info('shouldSkipFallback=true', {
      characterId,
      validFileCount: validSegs.length,
      totalMs,
      thresholds: { minFiles: MIN_FILES, minTotalMs: MIN_TOTAL_MS },
    })
  }
  return skip
}

/**
 * 构造 ffmpeg filter_complex：把源音频 `[0:a]` 按 character 的每个 segment 时间戳
 * 单独 `atrim` 出来，无缝 concat 成基础样本 [outa]。
 *
 * v0.4.20: 简化为"只做无缝拼接"——循环复制改用 stage 里的 `stream_loop` 直接处理
 * 整个 wav，避免在 filter 链里夹 100ms 静音（MiniMax 会把静音学成"说话间隔"特征）。
 *
 * 例（2 段）：
 *   [0:a]atrim=...[s0];
 *   [0:a]atrim=...[s1];
 *   [s0][s1]concat=n=2:v=0:a=1[outa]
 */
const buildSampleConcatFilter = (
  segs: Array<{ startMs: number; endMs: number }>,
): string => {
  const parts: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const startSec = (s.startMs / 1000).toFixed(3)
    const endSec = (s.endMs / 1000).toFixed(3)
    parts.push(
      `[0:a]atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS[s${i}]`,
    )
  }
  const labels = segs.map((_, i) => `[s${i}]`).join('')
  parts.push(`${labels}concat=n=${segs.length}:v=0:a=1[outa]`)
  return parts.join(';\n')
}
