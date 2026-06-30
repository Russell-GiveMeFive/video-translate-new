import type { AlignDecision } from '@dramaprime/core-types'
import {
  type AlignConfig,
  type AlignPlan,
  type AlignTarget,
  DEFAULT_ALIGN_CONFIG,
} from './types.js'
import { computeBorrowableGaps, type GapMap } from './gap.js'

/**
 * 5 级级联对齐决策（PRD §9.1）：
 *
 *   Stage 1 fit         | 偏差 ≤ 容差，啥都不用做
 *   Stage 2 speed       | 偏差小，但能用 TTS speed 调节（仅在调用方愿意重合成时启用；v0.3 跳过）
 *   Stage 3 sola        | 弹性变速 SOLA（Rubber Band），不变音高
 *   Stage 4 gap-borrow  | 借用相邻 segment 的间隙
 *   Stage 5 video-slow  | 视频局部慢放（D2 默认 ±5%）
 *   Stage 6 overflow    | 红色警告，等人工
 *
 * v0.3 注意：Stage 2 暂未启用——重新调 TTS API 太慢且会重复计费，
 * 等用户在 UI 单点"重新合成此句"时再走那条路径。
 *
 * 返回与 targets 对齐的 AlignPlan 数组（同长度、同序）。
 */
export function planAlignment(
  targets: AlignTarget[],
  cfg: AlignConfig = DEFAULT_ALIGN_CONFIG,
): AlignPlan[] {
  // 先计算每个 segment 与下一段之间的可借用间隙（连续段为 0）
  const gaps: GapMap = computeBorrowableGaps(targets)

  // 维护"已被前面 segment 借走"的状态：避免相邻两段都借同一个间隙
  const consumedNextGap = new Map<string, number>()

  return targets.map((t, i) => {
    const offsetMs = t.ttsDurMs - t.originalDurMs
    const absOffset = Math.abs(offsetMs)

    // ─── Stage 1: fit ──────────────────────────────────────────────
    if (absOffset <= cfg.toleranceMs) {
      return mkPlan(t, {
        strategy: 'fit',
        finalDurMs: t.ttsDurMs,
        offsetMs,
        flag: 'green',
      })
    }

    // 比例
    const ratio = t.ttsDurMs / t.originalDurMs

    // ─── Stage 3: SOLA 弹性变速 ────────────────────────────────────
    if (ratio >= cfg.solaRange[0] && ratio <= cfg.solaRange[1]) {
      const solaRatio = t.originalDurMs / t.ttsDurMs // 把 ttsDur 拉伸为 origDur 所需的 ratio
      return mkPlan(
        t,
        {
          strategy: 'sola',
          appliedSolaRatio: round3(solaRatio),
          finalDurMs: t.originalDurMs,
          offsetMs: 0,
          flag: 'green',
        },
        { needsSolaTransform: true, solaRatio },
      )
    }

    // ─── Stage 4: gap-borrow（TTS 长于槽位，可向后借间隙） ──────────
    if (cfg.enableGapBorrow && ratio > 1) {
      const availableNext = (gaps[t.segmentId]?.toNext ?? 0) - (consumedNextGap.get(t.segmentId) ?? 0)
      // 也可以向前借（前 segment 的"toNext"还没用完）
      const prev = targets[i - 1]
      const availablePrev = prev
        ? (gaps[prev.segmentId]?.toNext ?? 0) - (consumedNextGap.get(prev.segmentId) ?? 0)
        : 0
      const needed = t.ttsDurMs - t.originalDurMs
      const usableNext = Math.min(availableNext, needed)
      const usablePrev = Math.min(availablePrev, needed - usableNext)
      const totalBorrowed = usableNext + usablePrev
      if (totalBorrowed >= needed - cfg.toleranceMs) {
        // 把"借走的间隙"标记，给后续 segment 看
        if (usableNext > 0) {
          consumedNextGap.set(t.segmentId, (consumedNextGap.get(t.segmentId) ?? 0) + usableNext)
        }
        if (usablePrev > 0 && prev) {
          consumedNextGap.set(prev.segmentId, (consumedNextGap.get(prev.segmentId) ?? 0) + usablePrev)
        }
        const finalDur = t.originalDurMs + totalBorrowed
        return mkPlan(
          t,
          {
            strategy: 'gap-borrow',
            borrowedFrom: usableNext >= usablePrev ? 'next' : 'prev',
            borrowedMs: totalBorrowed,
            finalDurMs: finalDur,
            offsetMs: t.ttsDurMs - finalDur,
            flag: 'green',
          },
          { gapBorrowMs: totalBorrowed },
        )
      }
    }

    // ─── Stage 5: video-slow（D2 默认开启，±videoSlowMaxRatio 内） ──
    if (cfg.enableVideoSlow && ratio > 1) {
      const slowNeeded = (t.ttsDurMs - t.originalDurMs) / t.originalDurMs
      if (slowNeeded <= cfg.videoSlowMaxRatio) {
        return mkPlan(
          t,
          {
            strategy: 'video-slow',
            videoSlowRatio: round3(slowNeeded),
            finalDurMs: t.ttsDurMs,
            offsetMs: 0,
            flag: 'yellow', // 物理上动了原片，标黄色提示
          },
          { videoSlowRatio: slowNeeded },
        )
      }
    }

    // ─── Stage 5.5: 超出 SOLA 范围但还能用 SOLA 极限拉伸救回 ──────
    // 此时音频质量会有些不自然，但比 overflow 强；标黄色
    if (ratio > cfg.solaRange[1] && ratio < 1.6) {
      // ttsDur 远长于 origDur：用最大可接受拉伸
      const solaRatio = 1 / Math.min(ratio, 1.55)
      return mkPlan(
        t,
        {
          strategy: 'sola',
          appliedSolaRatio: round3(solaRatio),
          finalDurMs: Math.round(t.ttsDurMs * solaRatio),
          offsetMs: Math.round(t.ttsDurMs * solaRatio) - t.originalDurMs,
          flag: 'yellow',
        },
        { needsSolaTransform: true, solaRatio },
      )
    }
    // 用户决议："TTS 比原句短" → 用 SOLA 拉长原始音频（不是拉长视频画面，那是 v1.1）
    // 短剧场景这个比例通常在 0.7-0.95 之间，SOLA 拉伸 5-30% 几乎听不出来
    if (ratio < cfg.solaRange[0] && ratio > 0.55) {
      // ttsDur 短于 origDur：把 TTS 拉伸到 origDur（保持唇形对齐）
      const solaRatio = t.originalDurMs / t.ttsDurMs // 拉伸比 > 1
      return mkPlan(
        t,
        {
          strategy: 'sola',
          appliedSolaRatio: round3(solaRatio),
          finalDurMs: t.originalDurMs,
          offsetMs: 0,
          flag: 'green', // 短剧短 5-30% 拉伸基本听不出，标绿色
        },
        { needsSolaTransform: true, solaRatio },
      )
    }

    // ─── Stage 6: overflow（红色，等人工） ──────────────────────────
    const flag = absOffset >= 300 ? 'red' : 'yellow'
    return mkPlan(t, {
      strategy: 'overflow',
      finalDurMs: t.ttsDurMs,
      offsetMs,
      flag,
    })
  })
}

const mkPlan = (
  t: AlignTarget,
  decision: AlignDecision,
  extras: Partial<Pick<AlignPlan, 'needsSolaTransform' | 'solaRatio' | 'gapBorrowMs' | 'videoSlowRatio'>> = {},
): AlignPlan => ({
  segmentId: t.segmentId,
  decision,
  needsSolaTransform: extras.needsSolaTransform ?? false,
  solaRatio: extras.solaRatio,
  gapBorrowMs: extras.gapBorrowMs,
  videoSlowRatio: extras.videoSlowRatio,
})

const round3 = (n: number): number => Math.round(n * 1000) / 1000
