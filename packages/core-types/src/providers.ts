// ─── Provider 抽象接口 ─────────────────────────────────────────────────
// 实际实现在 @dramaprime/provider-MiniMax / @dramaprime/provider-volcengine
// 这里只定义"形状"，方便 main 在依赖注入与 mock 时使用

/** 文本 block */
export interface ContentBlockText {
  type: 'text'
  text: string
}

/**
 * 图片 block——按 Anthropic 兼容格式。
 * media_type: image/jpeg | image/png | image/webp | image/gif
 * data: base64-encoded（不带 data:image/...;base64, 前缀）
 */
export interface ContentBlockImage {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
    data: string
  }
}

export type ContentBlock = ContentBlockText | ContentBlockImage

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /**
   * 纯文本场景直接 string；多模态（含图片）传 ContentBlock[]
   * Anthropic schema 兼容。
   */
  content: string | ContentBlock[]
}

export interface ChatInput {
  model?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  expectJson?: boolean
  signal?: AbortSignal
}

export interface ChatOutput {
  text: string
  usage: { promptTokens: number; completionTokens: number }
  costCents: number
  requestId?: string
}

export interface LlmProvider {
  readonly name: string
  chat(input: ChatInput): Promise<ChatOutput>
  estimateCost(input: ChatInput): number
}

export interface TtsInput {
  model?: string
  text: string
  voiceId: string
  speed?: number
  vol?: number
  pitch?: number
  format?: 'wav' | 'mp3' | 'pcm'
  sampleRate?: number
  emotion?: string
  /**
   * 情绪强度 [0.5, 2.0]，默认 1.0。
   * MiniMax 文档：emotion_intensity，配合 emotion 字段使用——
   * 1.0 是中性强度，>1 更夸张更饱满；短剧 dubbing 推荐 1.4-1.6
   */
  emotionIntensity?: number
  languageBoost?: string
  /**
   * 是否启用英文文本归一化（数字 → 单词、缩写展开）
   * MiniMax 文档：english_normalization，默认 false，开了会让 "10" → "ten"
   */
  englishNormalization?: boolean
  /**
   * voice_modify 高级声纹调节（MiniMax 独立顶层字段，与 voice_setting 平级）。
   *
   * 客户口述的"撕心裂肺"参数 `{pitch: 20, intensity: -50}` 走的就是这里——
   * 与 voice_setting.pitch / voice_setting.emotion_intensity 是两个独立维度：
   *   - voice_setting.pitch [-12, +12]：粗粒度音高偏移（整体升降调）
   *   - voice_modify.pitch  范围更大：声纹层面的高音特征强化
   *   - voice_setting.emotion_intensity [0.5, 2.0]：情绪饱满度
   *   - voice_modify.intensity [-100, +100]：声纹强度（负值更"压抑"，正值更"夸张"）
   *
   * 不传时 MiniMax 用默认声纹（不修改）。
   */
  voiceModify?: {
    pitch?: number
    intensity?: number
    timbre?: number
    sound_effects?: string
  }
  signal?: AbortSignal
}

export interface TtsOutput {
  audioPath: string
  durationMs: number
  costCents: number
  requestId?: string
}

export interface TtsProvider {
  readonly name: string
  synthesize(input: TtsInput): Promise<TtsOutput>
  estimateCost(input: TtsInput): number
}

export interface CloneInput {
  fileId: string
  suggestedVoiceId?: string
  model?: string
  signal?: AbortSignal
}

export interface VoiceCloneProvider {
  readonly name: string
  upload(samplePath: string, signal?: AbortSignal): Promise<{ fileId: string }>
  clone(input: CloneInput): Promise<{ voiceId: string; expiresAt: number }>
  promote(voiceId: string): Promise<void>
}

export interface AsrInput {
  audioPath: string
  language?: string
  hintSpeakerCount?: number
  signal?: AbortSignal
}

export interface AsrUtterance {
  startMs: number
  endMs: number
  text: string
  confidence: number
  speakerId: string
  /** 可选：火山支持 enable_gender_detection 时返回 'male'/'female' */
  gender?: 'male' | 'female'
  /** 可选：火山支持 enable_emotion_detection 时返回 happy/sad/angry/neutral/surprise */
  emotion?: string
  /** 可选：语速（token/s） */
  speechRate?: number
  /** 可选：音量（dB） */
  volume?: number
  /**
   * 可选：词级时间戳。火山 `show_utterances=true` 时返回。
   * 用于 asr-diarize stage 在标点 / 长度阈值处把长 utterance 再切分。
   */
  words?: AsrWord[]
}

export interface AsrWord {
  startMs: number
  endMs: number
  text: string
  /** 此 word 前的静音 ms（火山 blank_duration） */
  blankBeforeMs?: number
}

export interface AsrOutput {
  language: string
  utterances: AsrUtterance[]
  speakers: { id: string; sampleCount: number; totalDurMs: number }[]
  costCents: number
  requestId?: string
}

export interface AsrProvider {
  readonly name: string
  transcribe(input: AsrInput): Promise<AsrOutput>
  estimateCost(input: AsrInput): number
}

// ─── Registry ─────────────────────────────────────────────────────────
export interface ProviderRegistry {
  llm: LlmProvider
  tts: TtsProvider
  clone: VoiceCloneProvider
  asr: AsrProvider
}
