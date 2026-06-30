import type { AlignTarget } from './types.js'

/**
 * 句段间的可借用间隙：
 *   - toNext: 该 segment 结束 → 下一段开始之间的静音时长 ms
 *   - fromPrev: 上一段结束 → 该 segment 开始之间的静音时长 ms（与上一段 toNext 等价）
 *
 * 假设：targets 已按 originalStartMs 升序排列。
 */
export interface GapInfo {
  toNext: number
  fromPrev: number
}

export type GapMap = Record<string, GapInfo>

export function computeBorrowableGaps(targets: AlignTarget[]): GapMap {
  const map: GapMap = {}
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!
    const next = targets[i + 1]
    const prev = targets[i - 1]
    map[t.segmentId] = {
      toNext: next ? Math.max(0, next.originalStartMs - t.originalEndMs) : 0,
      fromPrev: prev ? Math.max(0, t.originalStartMs - prev.originalEndMs) : 0,
    }
  }
  return map
}
