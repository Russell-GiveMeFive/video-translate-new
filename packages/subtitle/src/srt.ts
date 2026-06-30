import type { SubtitleCue } from './types.js'

/**
 * 生成 SRT 字幕。
 * SRT 协议简单，但不支持样式 / 双语布局——双语场景请用 ASS。
 *
 *   1
 *   00:00:01,500 --> 00:00:03,200
 *   字幕文本
 *
 *   2
 *   ...
 */
export interface SrtOptions {
  /** 双语时，是否原文与译文用 `\n` 分两行 */
  bilingual?: boolean
}

export function renderSrt(cues: SubtitleCue[], opts: SrtOptions = {}): string {
  const lines: string[] = []
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!
    lines.push(String(i + 1))
    lines.push(`${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}`)
    if (opts.bilingual && c.secondaryText) {
      lines.push(c.secondaryText.trim())
      lines.push(c.primaryText.trim())
    } else {
      lines.push(c.primaryText.trim())
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** ms → "HH:MM:SS,mmm" */
export function msToSrtTime(ms: number): string {
  if (ms < 0) ms = 0
  const milli = ms % 1000
  const totalSec = Math.floor(ms / 1000)
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const min = totalMin % 60
  const h = Math.floor(totalMin / 60)
  return `${pad2(h)}:${pad2(min)}:${pad2(s)},${pad3(milli)}`
}

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n))
const pad3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : String(n))
