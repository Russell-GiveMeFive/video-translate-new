import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult } from '@dramaprime/core-types'
import { ProjectRepo } from '../storage/project-repo.js'
import { requireFfmpeg, resolveDemucs, runCmd } from '../ffmpeg/index.js'

/**
 * v0.4 真实 demix stage：调 demucs CLI 把人声 / 伴奏分离。
 *
 *   输入：源视频
 *   输出：
 *     stems/vocals.wav   纯人声（asr-diarize + voice-clone 用）
 *     stems/accompaniment.wav  BGM + 音效（mix-render 用作背景）
 *
 * 实现：
 *   1. 先 ffmpeg 抽 16k stereo wav（demucs 用立体声效果更好）
 *   2. 调 demucs 跑分离：
 *        demucs --two-stems vocals -o stems/ in.wav
 *      产物会在 stems/htdemucs/<base>/{vocals,no_vocals}.wav
 *   3. 把产物挪到 stems/{vocals,accompaniment}.wav（标准化路径）
 *   4. demucs 不可用时 → kind: 'skipped'，下游用源视频音轨兜底
 *
 * 用户安装 demucs：
 *   pip install demucs              （需 Python 3.8+，会装 torch 等依赖 ~3GB）
 *   或 brew install demucs           （macOS）
 *   或 v0.5 由我们打 standalone binary 内嵌
 */
export const realDemixStage: Stage = {
  name: 'demix',
  version: 1,
  inputsFrom: ['preprocess'],
  /** 失败不阻塞——没装 demucs 时下游用源音轨兜底 */
  blocking: false,
  retries: 1,
  kind: 'sidecar',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const demucs = resolveDemucs()
    if (!demucs) {
      ctx.logger.warn(
        '⚠️ demucs 未找到，跳过人声分离。下游将使用源音轨（**原人声 + TTS 重合**，听感差）。',
      )
      ctx.logger.warn(
        '安装方法：pip install demucs（首次会下载 ~3GB 模型 + 依赖）；或 brew install demucs（macOS）。',
      )
      ctx.logger.warn(
        '装完后重跑此 project 即可（resolveDemucs 缓存会在下次启动失效）。',
      )
      return {
        kind: 'skipped',
        reason:
          '⚠️ demucs 未安装，输出视频会出现"原语种与译制语种重合"。请 `pip install demucs` 后重跑。',
      }
    }
    ctx.logger.info('demucs 解析成功', { path: demucs })

    const project = ProjectRepo.get(ctx.projectId as any)
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

    const stemsDir = join(ctx.projectDir, 'stems')
    await mkdir(stemsDir, { recursive: true })

    // ── Step 1: ffmpeg 抽 wav 喂给 demucs ───────────────────
    // demucs 默认 44.1k stereo；要求高质量分离用 44.1k 而非 16k
    ctx.reportProgress(5, '抽取音频送入分离器')
    const ffmpeg = requireFfmpeg()
    const wavInput = join(stemsDir, '_input.wav')
    const r1 = await runCmd(
      ffmpeg,
      [
        '-i',
        project.sourcePath,
        '-vn',
        '-ac',
        '2', // stereo
        '-ar',
        '44100',
        '-acodec',
        'pcm_s16le',
        '-y',
        wavInput,
      ],
      { signal: ctx.signal },
    )
    if (r1.code !== 0 || !existsSync(wavInput)) {
      return {
        kind: 'failed',
        error: {
          code: 'ffmpeg.encode-failed',
          message: `ffmpeg 抽音失败 (code=${r1.code}): ${r1.stderr.slice(0, 300)}`,
          retriable: true,
        },
      }
    }

    // ── Step 2: 调 demucs 分离 ─────────────────────────────
    // --two-stems vocals: 只产 vocals + no_vocals 两轨（不分 drums/bass/other）
    // -o: 输出根目录
    // 默认模型 htdemucs（4-stem）；--two-stems vocals 让它把非人声合并成 no_vocals
    ctx.reportProgress(25, '调 demucs 分离人声（约 30-60s）')
    const demucsOut = join(stemsDir, 'demucs')
    await mkdir(demucsOut, { recursive: true })

    const r2 = await runCmd(
      demucs,
      [
        '--two-stems',
        'vocals',
        // 用微调版 htdemucs_ft——分离更干净，但耗时是 htdemucs 的 4 倍左右
        // 短剧场景才几十秒，慢一点换更干净的 BGM 划算
        '-n',
        'htdemucs_ft',
        '-o',
        demucsOut,
        wavInput,
      ],
      {
        signal: ctx.signal,
        onStderrLine: (line) => {
          // demucs 输出形如 "Selected model: htdemucs" / "100%|████████| 1/1 [00:23<00:00, 23.45s/it]"
          const pct = line.match(/(\d+)%\|/)
          if (pct?.[1]) {
            const p = Number(pct[1])
            // 把 25 → 95 映射到 demucs 0-100%
            ctx.reportProgress(25 + Math.round(p * 0.7), `分离 ${p}%`)
          }
        },
      },
    )
    if (r2.code !== 0) {
      // 完整 stderr 进 logger（截断只截 user-facing 错误消息）——下次排查能拿到第二段栈
      ctx.logger.error('demucs 分离失败完整 stderr', {
        code: r2.code,
        demucsPath: demucs,
        stderr: r2.stderr,
      })
      const isBundled = demucs.includes('/binaries/demucs/')
      const hint = isBundled
        ? '排查：当前用的是 bundled PyInstaller binary。设环境变量 DRAMAPRIME_DEMUCS_PATH=$(which demucs) 切到 pip 装的版本试试。'
        : '排查：当前用的是 system demucs。可尝试 pip install --upgrade demucs；或临时设 DRAMAPRIME_DEMUCS_FORCE_BUNDLED=1 切回 bundled。'
      return {
        kind: 'failed',
        error: {
          code: 'sidecar.crashed',
          message: `demucs 分离失败 (code=${r2.code})。${hint}\n--- stderr (前 800 字) ---\n${r2.stderr.slice(0, 800)}`,
          retriable: true,
          context: { demucsPath: demucs, isBundled },
        },
      }
    }

    // ── Step 3: 找产物 + 标准化路径 ─────────────────────────
    // demucs 输出路径：<demucsOut>/<model_name>/<basename_no_ext>/{vocals,no_vocals}.wav
    ctx.reportProgress(95, '整理产物')
    const inputBase = '_input' // wavInput 不带扩展名
    const demucsResultDir = join(demucsOut, 'htdemucs_ft', inputBase)
    const srcVocals = join(demucsResultDir, 'vocals.wav')
    const srcNoVocals = join(demucsResultDir, 'no_vocals.wav')
    if (!existsSync(srcVocals) || !existsSync(srcNoVocals)) {
      return {
        kind: 'failed',
        error: {
          code: 'sidecar.crashed',
          message: `demucs 产物未找到：期望 ${srcVocals} 与 ${srcNoVocals}`,
          retriable: false,
          context: { demucsResultDir },
        },
      }
    }

    const vocals = join(stemsDir, 'vocals.wav')
    const accompaniment = join(stemsDir, 'accompaniment.wav')
    await rename(srcVocals, vocals).catch(async () => {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(srcVocals, vocals)
    })
    await rename(srcNoVocals, accompaniment).catch(async () => {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(srcNoVocals, accompaniment)
    })
    // 清掉中间产物
    await rm(demucsOut, { recursive: true, force: true }).catch(() => {})
    await rm(wavInput, { force: true }).catch(() => {})

    ctx.reportProgress(100, '分离完成')
    return {
      kind: 'ok',
      outputs: { vocals, accompaniment },
      durationMs: Date.now() - t0,
    }
  },
}
