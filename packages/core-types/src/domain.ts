// ─── 基础 ID 类型（Brand 类型，让 ts 帮我们区分） ──────────────────────────
declare const __brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type ProjectId = Brand<string, 'ProjectId'>
export type SegmentId = Brand<string, 'SegmentId'>
export type CharacterId = Brand<string, 'CharacterId'>
export type VoiceId = Brand<string, 'VoiceId'>
export type StageRunId = Brand<string, 'StageRunId'>
export type BatchId = Brand<string, 'BatchId'>

export const asProjectId = (s: string) => s as ProjectId
export const asSegmentId = (s: string) => s as SegmentId
export const asCharacterId = (s: string) => s as CharacterId
export const asVoiceId = (s: string) => s as VoiceId
export const asBatchId = (s: string) => s as BatchId

// ─── 项目 ─────────────────────────────────────────────────────────────
export type ProjectStatus = 'created' | 'running' | 'paused' | 'done' | 'failed'

export type RenderPreset =
  | 'reelshort-9x16-1080p'
  | 'dramabox-9x16-1080p'
  | 'tiktok-9x16-1080p'
  | 'youtube-shorts-9x16-1080p'
  | 'custom'

export interface ProjectConfig {
  /** 目标语种 ISO code（en/es/pt/ja/id/...） */
  targetLang: string
  /** 渲染预设 */
  renderPreset: RenderPreset
  /** 时长对齐策略 */
  align: {
    /** 句级容差 ms（默认 100） */
    toleranceMs: number
    /** 是否启用视频局部慢放 (D2 ✅ 默认 on，限 ±5%) */
    enableVideoSlow: boolean
    /** 视频慢放最大比例（D2 ✅ 默认 0.05） */
    videoSlowMaxRatio: number
  }
  /** 翻译风格 */
  translation: {
    style: 'literal' | 'localized' | 'caption' | 'dubbing'
    glossaryEnabled: boolean
  }
  /** TTS 默认模型 */
  tts: {
    model: 'speech-2.8-hd' | 'speech-2.8-turbo' | 'speech-2.6-hd' | 'speech-2.6-turbo'
    /**
     * 项目级 baseline 增益——叠在所有句子的 emotion tuning 之上。
     *
     * v0.4 之前每句只受 emotion 影响，neutral 句完全不调任何参数 →
     * "整体软塌不饱满"反馈的根因。引入 baseline 后：
     *   - neutral 句也能拿到 vol×1.15 + intensity+0.15，听感饱满
     *   - 情绪句仍然在 baseline 之上叠 delta，保留动态对比
     *
     * 取值范围（沿用 MiniMax 接口）：
     *   - vol:       [0.0, 10.0]   推荐 [1.0, 1.5]，过高失真
     *   - intensity: [0.5, 2.0]    推荐 [1.0, 1.5]，过高变"配音腔"
     *   - pitch:     [-12, +12]    半音偏移；非 0 时容易变声，谨慎
     *
     * 不传时用 DEFAULT_TTS_BASELINE。
     */
    baselineGain?: TtsBaselineGain
  }
  /** LLM 默认模型 */
  llm: {
    model: 'MiniMax-M3' | 'MiniMax-M2.7' | 'MiniMax-M2.7-highspeed'
  }
  /** 字幕烧录（D4 ✅ v1.0 不做抠除，只能烧新字幕） */
  subtitle: {
    burnIn: boolean
    /** 双语对照仅中-英 (D13 ✅) */
    bilingual: boolean
    style?: SubtitleStyle
  }
  /**
   * v0.4.9 VLM OCR 字幕识别（识别原片烧录中文字幕的真实时间轴，重切 segment）。
   *
   * ⚠️ v0.5 状态：**VLM OCR 已全局禁用**，stage 顶部无条件 skipped → 走 ASR。
   *   决策原因详见 `vlm-ocr-stage.ts` 顶部注释。
   *   下面两个字段保留为元信息 / 老 project 兼容，不再驱动行为。
   *   未来若 OCR 精度提升或换 provider 想重启，删除 stage 那段 return 即可恢复语义。
   *
   * 字段语义（历史保留）：
   *
   * 1. hasBurnedInSubtitles（视频属性，仍可能被字幕烧录等其他 stage 用）：
   *    - true：原片有烧录中文字幕
   *    - false：原片无字幕（如纯对白短剧）
   *
   * 2. strategy（已弃用 deprecated）：
   *    - 'vlm' / 'asr'：原本用来选 OCR 策略；现在 stage 不再读它
   */
  ocr: {
    /** 原片是否有烧录中文字幕（视频属性元信息） */
    hasBurnedInSubtitles: boolean
    /** @deprecated v0.5 VLM OCR 已全局禁用；字段保留仅为老 project 兼容 */
    strategy?: 'vlm' | 'asr'
  }
}

export interface SubtitleStyle {
  fontFamily: string
  fontSizePx: number
  primaryColor: string
  outlineColor: string
  outlineWidth: number
  bottomMarginPx: number
}

/**
 * TTS 项目级 baseline 增益。
 * 详见 ProjectConfig.tts.baselineGain 注释。
 */
export interface TtsBaselineGain {
  /** 音量倍率叠加：实际 vol = emotion.vol × baseline.vol（推荐 [1.0, 1.5]） */
  vol: number
  /** 情绪强度叠加：实际 intensity = emotion.intensity + baseline.intensity - 1（推荐 [1.0, 1.5]） */
  intensity: number
  /** 音高偏移叠加：实际 pitch = emotion.pitch + baseline.pitch（推荐 0；非 0 易变声） */
  pitch: number
}

/**
 * v0.4.4 默认 baseline —— 客户两轮反馈"声音绵软"后的最新值。
 *
 * 设计取舍：
 *   - vol 1.5：v0.4 是 1.15，v0.4.3 是 1.3，仍嫌小 → 拉到 1.5。
 *     乘性叠 emotion.vol（angry 1.1 等）后最高 ~1.65，
 *     仍远低于 MiniMax 接受上限 10.0。
 *   - intensity 1.2：v0.4 是 1.15，再加一点让 neutral 句不软塌。
 *   - pitch 0：baseline 不动音高（避免整体变声）；短句呼喊单独 +3 走 boostByPunctuation
 *
 * 后续：UI 在「项目设置 → TTS」暴露调节滑块；UI 落地前，改这里即全局生效。
 */
export const DEFAULT_TTS_BASELINE: TtsBaselineGain = {
  vol: 1.5,
  intensity: 1.2,
  pitch: 0,
}

export interface CreateProjectInput {
  name: string
  sourcePath: string
  config: ProjectConfig
}

export interface ProjectSummary {
  id: ProjectId
  name: string
  sourceLang: string
  targetLang: string
  status: ProjectStatus
  currentStage: StageName | null
  sourceDurMs: number | null
  costTotalCents: number
  createdAt: number
  updatedAt: number
}

export interface ProjectDetail extends ProjectSummary {
  sourcePath: string
  sourceSizeBytes: number | null
  config: ProjectConfig
  stages: StageRecord[]
}

export interface ProjectFilter {
  status?: ProjectStatus[]
  targetLang?: string[]
  search?: string
  sort?: 'updated_desc' | 'created_desc' | 'name_asc'
}

// ─── Stage 记录 ─────────────────────────────────────────────────────────
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'aborted'

export type StageName =
  | 'preprocess'
  | 'import-precheck'
  | 'shot-detect'
  | 'demix'
  | 'asr-diarize'
  | 'ocr-assist'
  | 'cluster'
  | 'voice-clone'
  | 'translate'
  | 'tts-synth'
  | 'align'
  | 'subtitle-burn'
  | 'mix-render'
  | 'finalize'

export const ALL_STAGES: readonly StageName[] = [
  'preprocess',
  'import-precheck',
  'shot-detect',
  'demix',
  'asr-diarize',
  'ocr-assist',
  'cluster',
  'voice-clone',
  'translate',
  'tts-synth',
  'align',
  'subtitle-burn',
  'mix-render',
  'finalize',
] as const

export interface StageRecord {
  stage: StageName
  status: StageStatus
  attempts: number
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  costCents: number
  outputs: Record<string, string>
  error: string | null
}

// ─── 句段 ─────────────────────────────────────────────────────────────
export interface Segment {
  id: SegmentId
  projectId: ProjectId
  idx: number
  sceneIdx: number | null
  startMs: number
  endMs: number
  speakerId: string | null
  characterId: CharacterId | null
  srcText: string | null
  srcTextEdited: string | null
  ocrText: string | null
  tgtText: string | null
  tgtTextEdited: string | null
  tgtAudioPath: string | null
  tgtDurMs: number | null
  /**
   * v0.4.16 原音路径（每段的"参考发音"）
   * asr-diarize 阶段从 demix 的 vocals.wav 切出 [startMs, endMs] 区间，存 wav
   * "使用原音"开关启用时，mix-render 用这个文件替 TTS 产物
   */
  srcAudioPath: string | null
  /** v0.4.22 segment 级"使用原音"开关 — true 时 mix-render 用 srcAudioPath 替 TTS，仅这一句 */
  useOriginalAudio: boolean
  /** 缩略图路径（thumb-extract stage 写入）——v0.4.11 加在 Segment 主表，方便表格直显 */
  thumbPath: string | null
  align: AlignDecision | null
  locked: boolean
  emotion: Emotion | null
  flag: 'green' | 'yellow' | 'red' | null
}

export type Emotion = 'happy' | 'sad' | 'angry' | 'neutral' | 'fear' | 'surprise' | 'disgust'

export interface SegmentPatch {
  id: SegmentId
  tgtTextEdited?: string | null
  srcTextEdited?: string | null
  characterId?: CharacterId | null
  locked?: boolean
  emotion?: Emotion | null
}

/**
 * 单 segment 的所有"可视化"资产路径——给"工作台"面板用。
 *
 * 路径都是绝对路径；renderer 通过 system:read-file-as-data-url IPC 把它们转成 data URL 播放。
 * 字段可能为 null：对应阶段还没跑 / 跑失败 / 该 segment 没有该资产。
 */
export interface SegmentAssets {
  segmentId: SegmentId
  /** segment 起止 ms */
  startMs: number
  endMs: number
  /** 代表帧（thumb-extract stage 产出） */
  thumbPath: string | null
  /** 原音轨该 segment 的裁切（demux 后的 vocals.wav 按 startMs/endMs 抽出） */
  srcAudioPath: string | null
  /** 角色的克隆样本（voice-clone stage 上传给 MiniMax 的那段） */
  characterId: CharacterId | null
  characterName: string | null
  cloneSamplePath: string | null
  /** TTS 产出音频 */
  ttsAudioPath: string | null
  ttsDurMs: number | null
  /** TTS 实际输入文本（含 emotion 调整后的停顿标记 <#0.15#>） */
  ttsInputText: string | null
  /** TTS 使用的 voiceId（克隆 dp_xxx 或 系统 male-qn-jingying） */
  ttsVoiceId: string | null
  /** TTS 调用时的参数 */
  ttsParams: {
    emotion: string | null
    emotionIntensity: number | null
    speed: number | null
    vol: number | null
    pitch: number | null
  } | null
}

// ─── 时长对齐决策 ─────────────────────────────────────────────────────
export type AlignStrategy =
  | 'fit'
  | 'speed'
  | 'sola'
  | 'gap-borrow'
  | 'video-slow'
  | 'overflow'

export interface AlignDecision {
  strategy: AlignStrategy
  appliedSpeed?: number
  appliedSolaRatio?: number
  borrowedFrom?: 'prev' | 'next'
  borrowedMs?: number
  videoSlowRatio?: number
  finalDurMs: number
  offsetMs: number
  flag: 'green' | 'yellow' | 'red'
}

// ─── 角色 ─────────────────────────────────────────────────────────────
export type VoiceStatus = 'system' | 'temp' | 'permanent'
export type Gender = 'male' | 'female' | 'unknown'
export type AgeBand = 'child' | 'young' | 'adult' | 'elder'

export interface Character {
  id: CharacterId
  projectId: ProjectId
  name: string | null
  speakerId: string
  gender: Gender | null
  ageBand: AgeBand | null
  voiceId: string | null
  voiceStatus: VoiceStatus | null
  voiceExpiresAt: number | null
  needsReclone: boolean
  samplePath: string | null
  sampleScore: number | null
  segmentCount: number
  /**
   * v0.4.16 用户手动指定：mix-render 用 segments.src_audio_path 代替 TTS
   * 适用场景：克隆样本太短 / 克隆失败 / 用户就是喜欢原音
   * true = mix-render 跳过 TTS、用源音轨
   */
  useOriginalAudio: boolean
}

// ─── 音色资产库（跨项目） ─────────────────────────────────────────────
export interface VoiceAsset {
  id: string
  name: string
  voiceId: string
  provider: 'MiniMax'
  status: VoiceStatus
  expiresAt: number | null
  tags: string[]
  originProjectId: ProjectId | null
  samplePath: string | null
  createdAt: number
}

// ─── 批量 ─────────────────────────────────────────────────────────────
export interface BatchEnqueueInput {
  name?: string
  sources: string[]
  template: ProjectConfig
  concurrency?: number
}

export interface BatchStatus {
  id: BatchId
  name: string | null
  total: number
  done: number
  failed: number
  status: 'queued' | 'running' | 'done' | 'partial' | 'cancelled'
  createdAt: number
}

// ─── Pipeline 状态汇总（IPC） ─────────────────────────────────────────
export interface PipelineStatus {
  projectId: ProjectId
  status: ProjectStatus
  currentStage: StageName | null
  stages: StageRecord[]
  /** 估算剩余时间（ms），null = 未知 */
  etaMs: number | null
  costTotalCents: number
}

// ─── Provider / Key ───────────────────────────────────────────────────
export type ProviderName = 'MiniMax' | 'volcengine'

export type KeyName =
  | 'MiniMax.api_key'
  | 'MiniMax.group_id'
  | 'volcengine.app_id'
  | 'volcengine.access_token'
  | 'volcengine.cluster'

// ─── 成本 ─────────────────────────────────────────────────────────────
export type CostUnit = 'tokens' | 'chars' | 'seconds' | 'requests'

export interface CostEntry {
  projectId?: ProjectId
  stage?: StageName
  provider: ProviderName
  model: string
  units: number
  unitKind: CostUnit
  cents: number
  requestId?: string
  ts: number
}
