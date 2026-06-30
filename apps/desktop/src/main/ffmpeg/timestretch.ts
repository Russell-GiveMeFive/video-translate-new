import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCmd, requireFfmpeg } from '../ffmpeg/index.js'
import { AppError } from '@dramaprime/core-types'

let _cachedRubberband: string | null | undefined

/**
 * 找 rubberband 二进制：
 *   1. 项目随包 binaries/rubberband/<os>-<arch>/rubberband
 *   2. 系统 PATH（Mac: brew install rubberband / Linux: apt install rubberband-cli）
 *   3. 找不到 → null（fallback 到 ffmpeg atempo）
 */
const resolveRubberband = (): string | null => {
  if (_cachedRubberband !== undefined) return _cachedRubberband
  _cachedRubberband = findRubberband()
  return _cachedRubberband
}

const findRubberband = (): string | null => {
  const exe = process.platform === 'win32' ? 'rubberband.exe' : 'rubberband'
  const candidates = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
  for (const d of candidates) {
    const p = join(d, exe)
    if (existsSync(p)) return p
  }
  const envPath = process.env.PATH ?? ''
  for (const d of envPath.split(process.platform === 'win32' ? ';' : ':')) {
    if (!d) continue
    const p = join(d, exe)
    if (existsSync(p)) return p
  }
  return null
}

export interface TimeStretchOpts {
  /** 输入音频路径（mp3/wav） */
  inputPath: string
  /** 输出音频路径（同 ext） */
  outputPath: string
  /** 拉伸比例：output_dur / input_dur（>1 拉长、<1 压缩） */
  ratio: number
  signal?: AbortSignal
}

/**
 * 时域弹性变速（不变音高）：
 *
 *   1. 优先 rubberband CLI（最佳质量；ratio 范围广）
 *   2. 回退 ffmpeg atempo（内置；ratio ∈ [0.5, 2.0]）
 *      - 极端 ratio 会通过 chain 多个 atempo 实现：1.5x = 1.5、3x = 2 * 1.5
 *
 * 实际 rubberband 接口：
 *   rubberband --time <ratio> --frequency 0 --crisp 5 in.wav out.wav
 *   - --time: time-stretch ratio（注意 rubberband 的 --time 是 output/input）
 *   - --frequency 0: 不调音高
 *   - --crisp 5: 平衡设置
 */
export async function timeStretch(opts: TimeStretchOpts): Promise<void> {
  const { inputPath, outputPath, ratio, signal } = opts
  if (!existsSync(inputPath)) {
    throw new AppError({
      code: 'user.file-not-found',
      message: `align: 输入音频不存在 ${inputPath}`,
      retriable: false,
    })
  }
  if (Math.abs(ratio - 1) < 0.005) {
    // 几乎是 1.0，直接复制省事
    const { copyFile } = await import('node:fs/promises')
    await copyFile(inputPath, outputPath)
    return
  }
  // ratio 安全裹挟：避免上层算错
  const safeRatio = Math.max(0.5, Math.min(2.0, ratio))

  const rubber = resolveRubberband()
  if (rubber) {
    const args = [
      '--time',
      safeRatio.toFixed(4),
      '--frequency',
      '0',
      '--crisp',
      '5',
      inputPath,
      outputPath,
    ]
    const r = await runCmd(rubber, args, { signal })
    if (r.code === 0 && existsSync(outputPath)) return
    // rubberband 失败 → 落到 ffmpeg
  }

  // ffmpeg atempo 兜底
  const ffmpeg = requireFfmpeg()
  // atempo: 1.0 是不变；>1 是变快；<1 是变慢
  // 时间拉伸到 ratio 倍 = 让播放速度 = 1/ratio 倍 = atempo=1/ratio
  const atempoRate = 1 / safeRatio
  const filter = chainAtempo(atempoRate)
  const r = await runCmd(
    ffmpeg,
    ['-y', '-i', inputPath, '-filter:a', filter, outputPath],
    { signal },
  )
  if (r.code !== 0 || !existsSync(outputPath)) {
    throw new AppError({
      code: 'ffmpeg.encode-failed',
      message: `时间拉伸失败 (rubberband + ffmpeg 都失败): ${r.stderr.slice(0, 300)}`,
      retriable: true,
    })
  }
}

/**
 * ffmpeg atempo 单次只能 0.5..2.0。链式实现极端 rate：
 *   atempoRate = 0.3 → 0.5 * 0.6（0.5 在范围内，再乘 0.6 在范围内）
 *   atempoRate = 3.0 → 2.0 * 1.5
 */
const chainAtempo = (rate: number): string => {
  if (rate >= 0.5 && rate <= 2.0) return `atempo=${rate.toFixed(4)}`
  const parts: string[] = []
  let r = rate
  while (r > 2.0) {
    parts.push('atempo=2.0')
    r /= 2.0
  }
  while (r < 0.5) {
    parts.push('atempo=0.5')
    r /= 0.5
  }
  parts.push(`atempo=${r.toFixed(4)}`)
  return parts.join(',')
}

/** 检测当前系统有没有 rubberband 二进制（让 UI 提示用户） */
export const hasRubberband = (): boolean => resolveRubberband() !== null
