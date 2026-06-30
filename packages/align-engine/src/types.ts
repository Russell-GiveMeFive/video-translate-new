import type { AlignDecision, AlignStrategy } from '@dramaprime/core-types'

/**
 * Align engine 输入：每个 segment 的"原片槽位"和"当前 TTS 时长"。
 *
 * 一个 segment 在 align 之前必须经过 tts-synth，已经写入 tgtAudioPath / tgtDurMs。
 * align engine 决定该段用什么策略对齐，并产出执行指令。
 */
export interface AlignTarget {
  segmentId: string
  /** 在原视频里的开始 ms */
  originalStartMs: number
  /** 在原视频里的结束 ms */
  originalEndMs: number
  /** 原句槽位时长 ms */
  originalDurMs: number
  /** TTS 合成出来的音频路径（mp3 / wav） */
  ttsAudioPath: string
  /** TTS 合成时长 ms */
  ttsDurMs: number
  /** 译文文本（用于 stage 1 重生成时调 LLM 控长，目前未用） */
  tgtText: string
  /** 角色 voice_id（用于 stage 2 调 TTS speed 重合成，目前未用） */
  voiceId: string | null
}

/**
 * Align 配置：项目级开关与阈值。
 *
 * 与 PRD §9.1 决策对齐：
 *   - toleranceMs: 默认 100，认为 "fit" 的容差
 *   - speedRange: TTS speed 调节范围 [0.85, 1.15]（保持自然）
 *   - solaRange: 弹性变速比例范围 [0.7, 1.3]（Rubber Band 在此范围内几乎听不出处理）
 *   - enableVideoSlow: D2 ✅ 默认 true
 *   - videoSlowMaxRatio: 视频局部慢放最大比例 0.05（±5%）
 *   - enableGapBorrow: 从相邻 segment 间隙借时间，默认 true
 *   - minGapBorrowMs: 相邻间隙 ≥ 此值才能借
 */
export interface AlignConfig {
  toleranceMs: number
  speedRange: [number, number]
  solaRange: [number, number]
  enableVideoSlow: boolean
  videoSlowMaxRatio: number
  enableGapBorrow: boolean
  minGapBorrowMs: number
}

export const DEFAULT_ALIGN_CONFIG: AlignConfig = {
  toleranceMs: 100,
  speedRange: [0.85, 1.15],
  solaRange: [0.7, 1.3],
  enableVideoSlow: true,
  videoSlowMaxRatio: 0.05,
  enableGapBorrow: true,
  minGapBorrowMs: 200,
}

/**
 * Align "计划"：决策结果 + 待执行动作。
 *
 * planner.ts 产出 plan；调用方按 strategy 字段执行对应动作（调 rubberband / 重合成 TTS / 视频慢放等）。
 */
export interface AlignPlan {
  segmentId: string
  decision: AlignDecision
  /** 是否需要对 TTS 音频做 SOLA 变速；strategy='sola' 时 true */
  needsSolaTransform: boolean
  /** SOLA 拉伸比例：output_dur / input_dur，>1 为拉长、<1 为压缩 */
  solaRatio?: number
  /** strategy='gap-borrow' 时占用了多少 ms 的相邻间隙 */
  gapBorrowMs?: number
  /** strategy='video-slow' 时的视频慢放比例（如 0.04 = 慢 4%） */
  videoSlowRatio?: number
}

export type { AlignDecision, AlignStrategy }
