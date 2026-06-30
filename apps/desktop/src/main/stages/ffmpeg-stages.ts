import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult } from '@dramaprime/core-types'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo, CharacterRepo } from '../storage/index.js'
import {
  parseFfmpegTime,
  requireFfmpeg,
  requireFfprobe,
  runCmd,
} from '../ffmpeg/index.js'

/**
 * 真实 preprocess stage：
 *   1. ffprobe 读源视频元数据 → 写 preprocess/metadata.json
 *   2. ffmpeg 等间距抽 5 张 1080p 缩略图 → preprocess/thumbs/*.jpg
 *   3. 把视频时长回写 SQLite projects.source_dur_ms
 */
export const realPreprocessStage: Stage = {
  name: 'preprocess',
  version: 1,
  inputsFrom: [],
  blocking: true,
  retries: 2,
  kind: 'utility',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const ffprobe = requireFfprobe()
    const ffmpeg = requireFfmpeg()
    const t0 = Date.now()

    const project = ProjectRepo.get(ctx.projectId as any)
    const src = project.sourcePath
    if (!src || !existsSync(src)) {
      return {
        kind: 'failed',
        error: {
          code: 'user.file-not-found',
          message: `源视频不存在：${src}`,
          retriable: false,
        },
      }
    }

    const outDir = join(ctx.projectDir, 'preprocess')
    const thumbsDir = join(outDir, 'thumbs')
    await mkdir(thumbsDir, { recursive: true })

    // ── Step 1: ffprobe 读元数据 ─────────────────────────
    ctx.reportProgress(5, '读取视频元数据')
    const probe = await runCmd(
      ffprobe,
      [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        src,
      ],
      { signal: ctx.signal },
    )
    if (probe.code !== 0) {
      return {
        kind: 'failed',
        error: {
          code: 'ffmpeg.input-corrupted',
          message: `ffprobe 失败 (code=${probe.code}): ${probe.stderr.slice(0, 400)}`,
          retriable: false,
        },
      }
    }
    let probeData: ProbeOutput
    try {
      probeData = JSON.parse(probe.stdout) as ProbeOutput
    } catch (e) {
      return {
        kind: 'failed',
        error: {
          code: 'ffmpeg.input-corrupted',
          message: 'ffprobe 输出解析失败',
          retriable: false,
        },
      }
    }
    const meta = summarizeProbe(probeData)
    const metadataPath = join(outDir, 'metadata.json')
    await writeJson(metadataPath, meta)
    ctx.logger.info('preprocess metadata extracted', {
      durMs: meta.durationMs,
      w: meta.width,
      h: meta.height,
      fps: meta.fps,
    })

    // 回写到 SQLite
    if (meta.durationMs > 0) {
      try {
        ProjectRepo.setSourceMeta(ctx.projectId as any, {
          durationMs: meta.durationMs,
          sizeBytes: meta.sizeBytes,
        })
      } catch (err) {
        ctx.logger.warn('更新 project.source_dur_ms 失败', { err: String(err) })
      }
    }

    // ── Step 2: 抽 5 张缩略图 ─────────────────────────────
    ctx.reportProgress(25, '生成缩略图')
    if (meta.durationMs > 0) {
      const positions = [0.05, 0.25, 0.5, 0.75, 0.95] // 视频比例位置
      for (let i = 0; i < positions.length; i++) {
        if (ctx.signal.aborted) {
          return {
            kind: 'failed',
            error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
          }
        }
        const ts = (meta.durationMs / 1000) * positions[i]!
        const outPath = join(thumbsDir, `${String(i + 1).padStart(2, '0')}.jpg`)
        const r = await runCmd(
          ffmpeg,
          [
            '-ss',
            ts.toFixed(3),
            '-i',
            src,
            '-frames:v',
            '1',
            '-vf',
            'scale=480:-2',
            '-q:v',
            '4',
            '-y',
            outPath,
          ],
          { signal: ctx.signal },
        )
        if (r.code !== 0) {
          ctx.logger.warn('缩略图抽取失败', { idx: i, stderr: r.stderr.slice(0, 200) })
          // 缩略图失败不致命
        }
        ctx.reportProgress(
          25 + Math.round(((i + 1) / positions.length) * 65),
          `缩略图 ${i + 1}/${positions.length}`,
        )
      }
    }

    ctx.reportProgress(100, '预处理完成')
    return {
      kind: 'ok',
      outputs: {
        metadata: metadataPath,
        thumbs: thumbsDir,
      },
      durationMs: Date.now() - t0,
    }
  },
}

/**
 * 真实 mix-render stage：
 *   把原视频画面 + 译制人声轨（按 segments tgt_audio_path 拼接）合成一个新 mp4。
 *
 *   v0.2.b 策略：
 *   1. 用 ffmpeg concat protocol 把 tts 音频按 segment.startMs 拼到时间线
 *   2. 没 TTS 音频的 segments → 静音填充（保留原视频对应位置的背景音）
 *   3. 把拼好的人声音轨 -ac 1 与原视频画面合成新 mp4
 *
 *   v0.3 升级：
 *   - 接 align engine 后用对齐后的 .aligned.wav
 *   - demix 真实化后保留原背景音乐叠加（vocals 降到 -inf、music 保留）
 *   - 烧字幕（subtitle-burn stage 之后）
 */
export const realMixRenderStage: Stage = {
  name: 'mix-render',
  version: 1,
  inputsFrom: ['preprocess', 'tts-synth'],
  blocking: true,
  retries: 2,
  kind: 'utility',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const ffmpeg = requireFfmpeg()
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const src = project.sourcePath
    if (!src || !existsSync(src)) {
      return {
        kind: 'failed',
        error: {
          code: 'user.file-not-found',
          message: `源视频不存在：${src}`,
          retriable: false,
        },
      }
    }

    const outDir = join(ctx.projectDir, 'render')
    await mkdir(outDir, { recursive: true })
    const outPath = join(outDir, 'out.mp4')

    // v0.4.16 P1 → v0.4.22 优先级：
    //   1. segment.useOriginalAudio（per-segment 用户精确控制）
    //   2. character.useOriginalAudio（per-character 兜底，目前 UI 已下线但 DB 字段保留）
    // 用 src_audio_path 替 TTS
    const allSegs = SegmentRepo.list(ctx.projectId as any)
    const characters = CharacterRepo.list(ctx.projectId as any)
    const useOrigMap = new Map(characters.map((c) => [c.id, c.useOriginalAudio]))
    const resolveUseOrig = (s: typeof allSegs[number]): boolean =>
      s.useOriginalAudio || (useOrigMap.get(s.characterId as any) ?? false)
    const segs = allSegs.filter((s) => {
      const useOrig = resolveUseOrig(s)
      const audioPath = useOrig ? s.srcAudioPath : s.tgtAudioPath
      return audioPath && existsSync(audioPath)
    })
    const durMs = project.sourceDurMs ?? 0

    // 字幕烧入：subtitle-burn stage 产物是否存在？
    const subsAssPath = join(ctx.projectDir, 'subs', 'out.ass')
    const burnSubs = project.config.subtitle.burnIn && existsSync(subsAssPath)
    if (burnSubs) {
      ctx.logger.info('启用字幕烧入', { ass: subsAssPath })
    }

    // demix 产物的伴奏轨（accompaniment.wav）是否存在？
    // - 有：用纯 BGM/音效作为背景，音量正常（0.8） → 原人声完全消失
    // - 无：用源视频原音轨压低（0.18），凑合保留 BGM 但原人声残留
    const accompanimentPath = join(ctx.projectDir, 'stems', 'accompaniment.wav')
    const hasAccompaniment = existsSync(accompanimentPath)
    if (hasAccompaniment) {
      ctx.logger.info('使用 demix 伴奏轨作背景', { path: accompanimentPath })
    } else {
      ctx.logger.warn('未找到 demix 伴奏轨，用源音轨 -15dB 兜底（原人声会残留）')
    }

    let args: string[]
    if (segs.length === 0 || durMs === 0) {
      // 没有任何 TTS 产物 → 退化为 v0.2.a 行为：仅复制画面 + 原音轨
      ctx.logger.warn('未找到 TTS 产物或视频时长未知，退化为仅重编', {
        segCount: segs.length,
        durMs,
      })
      args = ['-i', src]
      if (burnSubs) {
        args.push('-vf', `subtitles=${escapeFfmpegPath(subsAssPath)}`)
      }
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-y',
        outPath,
      )
    } else {
      // 构造音轨拼接 + 可选字幕烧入 的 filter graph
      ctx.reportProgress(5, '构造混音 filter graph')
      const filterScript = buildAudioVideoFilterGraph(
        segs,
        durMs,
        burnSubs ? subsAssPath : null,
        hasAccompaniment,
      )
      const scriptPath = join(outDir, 'filter.txt')
      await writeFile(scriptPath, filterScript, 'utf8')

      // ffmpeg 命令：原视频 + （可选）伴奏轨 + 所有 TTS 音频
      args = ['-i', src]
      // 把伴奏轨作为额外输入（索引取决于位置）
      if (hasAccompaniment) {
        args.push('-i', accompanimentPath)
      }
      for (const s of segs) {
        const useOrig = resolveUseOrig(s)
        const audioPath = useOrig ? s.srcAudioPath : s.tgtAudioPath
        args.push('-i', audioPath!)
      }
      args.push(
        '-filter_complex_script',
        scriptPath,
        '-map',
        burnSubs ? '[outv]' : '0:v',
        '-map',
        '[outa]',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-shortest',
        '-y',
        outPath,
      )
    }

    let lastReported = 0
    let lastProgressAt = Date.now()
    // 防卡死 watchdog：60s 内 ffmpeg 没新进度 → 主动 abort（避免 filter graph bug 让用户死等）
    const watchdogController = new AbortController()
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > 60_000) {
        ctx.logger.error('ffmpeg 60s 无进度，触发 watchdog 终止', {
          lastReported,
        })
        watchdogController.abort()
      }
    }, 10_000)
    // 合并 ctx.signal + watchdog，避免 ctx.signal 被 watchdog 干扰
    const combinedSignal = AbortSignal.any([ctx.signal, watchdogController.signal])

    const result = await runCmd(ffmpeg, args, {
      signal: combinedSignal,
      onStderrLine: (line) => {
        const ms = parseFfmpegTime(line)
        if (ms == null || durMs <= 0) return
        lastProgressAt = Date.now() // 重置 watchdog
        const percent = Math.min(95, Math.round((ms / durMs) * 90) + 5)
        if (percent - lastReported >= 2) {
          ctx.reportProgress(
            percent,
            `渲染 ${(ms / 1000).toFixed(1)}s / ${(durMs / 1000).toFixed(1)}s`,
          )
          lastReported = percent
        }
      },
    })
    clearInterval(stallTimer)

    if (result.code !== 0) {
      const watchdogTriggered = watchdogController.signal.aborted && !ctx.signal.aborted
      return {
        kind: 'failed',
        error: {
          code: watchdogTriggered ? 'ffmpeg.encode-failed' : 'ffmpeg.encode-failed',
          message: watchdogTriggered
            ? `ffmpeg 60s 无进度被 watchdog 终止——通常是 filter graph 死循环。请把 render/filter.txt 发给开发者排查。`
            : `ffmpeg 渲染失败 (code=${result.code}): ${result.stderr.slice(0, 500)}`,
          retriable: true,
        },
      }
    }

    ctx.reportProgress(100, '渲染完成')
    return {
      kind: 'ok',
      outputs: { render: outPath },
      durationMs: Date.now() - t0,
    }
  },
}

/**
 * 构造 ffmpeg filter_complex 脚本：
 *   - 把 N 个 TTS 音频按各自 segment.startMs delay 后混合
 *   - 背景音：
 *     * hasAccompaniment=true → 用独立的伴奏轨（demix 产物，[1:a]），音量 0.8（接近原响度）
 *     * hasAccompaniment=false → 用源视频原音轨压低（[0:a]volume=0.18，-15dB）兜底
 *   - anullsrc 提供时长基线
 *
 *   有 demix 伴奏轨时：
 *     输入索引：[0]=源视频, [1]=accompaniment, [2..N+1]=TTS segments
 *     [1:a]volume=0.8[bg];
 *     [2:a]adelay=...[a0]; ...
 *     [bg][silence][a0][a1]...amix=...[outa]
 *
 *   没伴奏轨时：
 *     输入索引：[0]=源视频, [1..N]=TTS segments
 *     [0:a]volume=0.18[bg];
 *     [1:a]adelay=...[a0]; ...
 *     [bg][silence][a0][a1]...amix=...[outa]
 */
const buildAudioVideoFilterGraph = (
  segs: Array<{ tgtAudioPath: string | null; startMs: number }>,
  totalDurMs: number,
  /** 字幕 .ass 路径；非空时在视频流上加 subtitles= filter 烧入 */
  subtitlesPath: string | null,
  /** demix 伴奏轨是否可用 */
  hasAccompaniment: boolean,
): string => {
  const parts: string[] = []
  const labels: string[] = []
  const wholeDurMs = Math.round(totalDurMs)

  // 背景音
  if (hasAccompaniment) {
    // demix 伴奏轨 = 大部分 BGM/音效，但 demucs 仍会残留少量人声（尤其情绪激烈段）
    // 这里加一个轻度滤波链进一步压制残留：
    //   - highpass=60 → 切掉低频 hum/低频残留人声
    //   - lowpass=8000 → 切掉高频齿音（人声特征频段）
    //   - acompressor → 动态压缩，把还冒头的残留人声拉平
    //   - volume=0.7 → 适当降一点让译制 TTS 突出
    parts.push(
      `[1:a]highpass=f=60,lowpass=f=8000,acompressor=threshold=-20dB:ratio=4:attack=20:release=200,volume=0.7[bg]`,
    )
  } else {
    // 兜底：原音轨压低 -15dB（原中文人声会残留）
    parts.push(`[0:a]volume=0.18[bg]`)
  }

  // TTS 音轨索引：有伴奏时从 2 开始（0=视频, 1=伴奏, 2..N+1=TTS）；
  //                没伴奏时从 1 开始（0=视频, 1..N=TTS）
  const ttsStartIdx = hasAccompaniment ? 2 : 1
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const delay = Math.max(0, Math.round(s.startMs))
    parts.push(
      `[${ttsStartIdx + i}:a]adelay=${delay}|${delay},apad=whole_dur=${wholeDurMs}ms[a${i}]`,
    )
    labels.push(`[a${i}]`)
  }

  // 静音基线
  const silenceDurSec = (totalDurMs / 1000).toFixed(3)
  parts.push(`anullsrc=channel_layout=mono:sample_rate=32000:d=${silenceDurSec}[silence]`)

  const inputs = ['[bg]', '[silence]', ...labels].join('')
  const inputCount = labels.length + 2
  parts.push(
    `${inputs}amix=inputs=${inputCount}:duration=longest:dropout_transition=0:normalize=0[outa]`,
  )

  if (subtitlesPath) {
    parts.push(`[0:v]subtitles=${escapeFfmpegPath(subtitlesPath)}[outv]`)
  }

  return parts.join(';\n')
}

/**
 * ffmpeg filter 参数里路径转义：
 *   - 单引号 ' → \'
 *   - 反斜杠 \ → \\
 *   - 冒号 : → \:（避免被当 filter 参数分隔符）
 *   - Windows 路径里的 : 同样需要转义
 *
 * 参考：ffmpeg-filters 文档 "Notes on filtergraph escaping"
 */
const escapeFfmpegPath = (p: string): string => {
  return p
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
}

// ─── helpers ─────────────────────────────────────────────────────────

interface ProbeOutput {
  format?: { duration?: string; size?: string; bit_rate?: string }
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
    avg_frame_rate?: string
    channels?: number
    sample_rate?: string
  }>
}

interface VideoMeta {
  durationMs: number
  sizeBytes: number
  bitrate: number
  width: number
  height: number
  fps: number
  videoCodec: string | null
  audioCodec: string | null
  audioChannels: number
  audioSampleRate: number
}

const summarizeProbe = (p: ProbeOutput): VideoMeta => {
  const vs = p.streams?.find((s) => s.codec_type === 'video')
  const as_ = p.streams?.find((s) => s.codec_type === 'audio')
  const fps = parseFrameRate(vs?.r_frame_rate ?? vs?.avg_frame_rate)
  return {
    durationMs: Math.round(Number(p.format?.duration ?? 0) * 1000),
    sizeBytes: Number(p.format?.size ?? 0),
    bitrate: Number(p.format?.bit_rate ?? 0),
    width: vs?.width ?? 0,
    height: vs?.height ?? 0,
    fps,
    videoCodec: vs?.codec_name ?? null,
    audioCodec: as_?.codec_name ?? null,
    audioChannels: as_?.channels ?? 0,
    audioSampleRate: Number(as_?.sample_rate ?? 0),
  }
}

const parseFrameRate = (s: string | undefined): number => {
  if (!s) return 0
  const [num, den] = s.split('/').map(Number)
  if (!num || !den) return 0
  return Math.round((num / den) * 100) / 100
}

const writeJson = async (path: string, data: unknown): Promise<void> => {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
}
