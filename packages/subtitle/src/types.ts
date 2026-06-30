/**
 * 字幕生成模块的输入数据类型。
 *
 * 设计原则：模块对 Segment / Project 等业务类型零依赖——只接受最小信息。
 * 这样它能被 main 进程、未来的 web 端、CLI 工具任意复用。
 */

/** 一句字幕（与一个 segment 对应） */
export interface SubtitleCue {
  /** 顺序（用于 ID） */
  idx: number
  /** 起始时间 ms */
  startMs: number
  /** 结束时间 ms */
  endMs: number
  /** 主文本（译文，单语模式下唯一显示） */
  primaryText: string
  /** 副文本（原文，双语模式下作为另一行；单语模式忽略） */
  secondaryText?: string
}

/** 视频分辨率（用于字号自适应、安全区计算） */
export interface VideoMetrics {
  width: number
  height: number
}

/** 字幕样式配置（v0.4 用默认即可；v0.5 UI 编辑） */
export interface SubtitleStyle {
  /** 主字体（译文） */
  primaryFont: string
  /** 副字体（原文）；不传则用 primaryFont */
  secondaryFont?: string
  /** 字号（pt）；默认 48（在 1080p 上视觉舒服） */
  fontSize: number
  /** 副文本字号比例（默认 0.8） */
  secondaryFontScale: number
  /** 主颜色：白色 */
  primaryColor: string // hex `#RRGGBB`
  /** 副颜色：浅灰 */
  secondaryColor: string
  /** 描边颜色：黑 */
  outlineColor: string
  /** 描边宽度（px）；默认 2.5 */
  outlineWidth: number
  /** 阴影距离（px）；默认 0（描边已够） */
  shadowDistance: number
  /**
   * 底部边距占视频高度比例。
   * 默认 0.14（约 1/7）——短剧竖屏 9:16 时，0.14 × 1920 ≈ 268px，
   * 刚好避开 iOS / Android 底部手势条 + 用户拇指持机遮挡区。
   *
   * v0.4 之前是 0.06（约 115px），用户反馈"字幕太靠下、看着累"。
   * 长篇横屏可在 RenderOptions.style 里覆盖回 0.08。
   */
  bottomMarginRatio: number
  /**
   * 单行字符数软上限（用于 wrapCueText 自动折行）。
   * 中文按"字"算，英文按"字符"算（英文一个 word 一般几个字符）。
   * 默认 18——竖屏 1080×1920 + 48pt 字号下，单行约 16-18 字看着不挤。
   * 不传时 wrapCueText 退化为不折行（保持 libass 原生换行）。
   */
  maxCharsPerLine?: number
  /** 行间距 px；默认 6 */
  lineSpacing: number
  /** 是否启用粗体；中文短剧建议 true */
  bold: boolean
}

export const DEFAULT_STYLE: SubtitleStyle = {
  primaryFont: 'PingFang SC',
  secondaryFont: 'PingFang SC',
  // v0.4.8 字号 48→40：客户反馈 4 行字撑得太高、撞上原片中文字幕
  // 40pt 在 1080×1920 上单行 16-18 字仍清晰可读，4 行高度从 ~300px 降到 ~240px
  fontSize: 40,
  secondaryFontScale: 0.8,
  primaryColor: '#FFFFFF',
  secondaryColor: '#D0D0D0',
  outlineColor: '#000000',
  outlineWidth: 2.5,
  shadowDistance: 0,
  // v0.4.9 0.015→0.06：v0.4.8 压到 0.015 客户反馈"太靠下"（盖住 iOS home indicator + 拇指持机区）
  // 0.06（距底 6% = 1080p 约 115px）是 v0.1 原始默认，配合 fontSize 40 + maxCharsPerLine 24
  // 三行字幕总高度 ~200px，顶端在画面 79% 高度，仍在原片中文字幕带（~70%）之下
  bottomMarginRatio: 0.06,
  // v0.4.8 18→24：单行装更多字、减少行数，避免 4 行撑过原片字幕带
  maxCharsPerLine: 24,
  lineSpacing: 6,
  bold: true,
}

/** 生成器选项 */
export interface RenderOptions {
  /** 视频实际分辨率（影响 PlayResX/Y 与字号自适应） */
  metrics: VideoMetrics
  /** 样式（不传用默认） */
  style?: Partial<SubtitleStyle>
  /** 是否生成双语（中英）；false 时只用 primaryText */
  bilingual: boolean
}
