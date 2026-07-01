import type {
  ProjectId,
  CreateProjectInput,
  ProjectSummary,
  ProjectDetail,
  ProjectFilter,
  PipelineStatus,
  Segment,
  SegmentPatch,
  SegmentId,
  SegmentAssets,
  Character,
  CharacterId,
  VoiceAsset,
  KeyName,
  ProviderName,
  StageName,
  BatchEnqueueInput,
  BatchStatus,
  BatchId,
  OriginalAudioRange,
} from './domain.js'
import type { NormalizedError } from './errors.js'

// IPC 返回包装。所有 invoke 都返回这个，强制 Renderer 处理 error 分支。
export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: NormalizedError }

/**
 * IPC 通道与类型契约的单一来源。
 *
 * 命名规范：`<domain>:<action>`。新增 IPC 通道必须先改这里，再实现 handler 与
 * preload 暴露。Renderer 通过 `window.api.invoke<K>(key, payload)` 调用，
 * payload 类型为 `Parameters<ApiSurface[K]>[0]`，返回 `Awaited<ReturnType<ApiSurface[K]>>`。
 */
export type ApiSurface = {
  // ---- system ----
  'system:ready': () => Promise<{ version: string; platform: string; locale: string }>
  'system:select-file': (opts: {
    kind: 'video' | 'audio' | 'srt'
    multi?: boolean
  }) => Promise<string[]>
  'system:open-in-explorer': (path: string) => Promise<void>
  'system:reveal-logs': () => Promise<void>
  /** v0.4.12 系统级通知（macOS / Windows 原生气泡）。Linux 无原生支持会静默返回 */
  'system:notify': (payload: {
    type: 'info' | 'success' | 'warn' | 'error'
    title: string
    body?: string
  }) => Promise<{ shown: boolean; reason?: string }>
  /** 读取项目内文件转 data URL（renderer 没文件系统权限，用 IPC 中转） */
  'system:read-file-as-data-url': (input: {
    path: string
    /** 仅允许的 MIME 前缀，安全用——只放音频和图片 */
    mimeHint?: 'audio' | 'image'
  }) => Promise<{ dataUrl: string; sizeBytes: number; mimeType: string }>

  // ---- keystore ----
  'keystore:get': (key: KeyName) => Promise<string | null>
  'keystore:set': (input: { key: KeyName; value: string }) => Promise<void>
  'keystore:test': (
    provider: ProviderName,
  ) => Promise<{ ok: boolean; balanceCents?: number; error?: string }>

  // ---- project ----
  'project:create': (input: CreateProjectInput) => Promise<ProjectId>
  'project:list': (filter?: ProjectFilter) => Promise<ProjectSummary[]>
  'project:get': (id: ProjectId) => Promise<ProjectDetail>
  'project:delete': (id: ProjectId) => Promise<void>
  'project:duplicate': (id: ProjectId) => Promise<ProjectId>
  'project:import': (path: string) => Promise<ProjectId>
  'project:export': (input: { id: ProjectId; output: string }) => Promise<void>
  /**
   * v0.5 更新"保留原音"时间范围（预处理 tab 用）。
   * 落库后自动清掉 mix-render + subtitle-burn 的 done 状态，工作台会看到它们变 pending 可重跑。
   */
  'project:set-original-audio-ranges': (input: {
    id: ProjectId
    ranges: OriginalAudioRange[]
  }) => Promise<void>
  /**
   * v0.5 让 renderer 播源视频：把源视频路径加入 app:// 白名单，返回可播 URL
   * 每次切项目 renderer 都要调一次；main 保证 ALLOWED_ROOTS 只留最新那个源。
   */
  'project:register-source-preview': (input: {
    id: ProjectId
  }) => Promise<{ url: string }>
  /**
   * v0.5 读 preprocess/metadata.json + 缩略图 URL 列表 —— 给预处理 tab。
   * 未跑过 preprocess 时返回 null（预处理 tab 会退化到 ms-only 显示、无缩略图背景）。
   * thumbnails：按视频比例位置顺序，5 张缩略图的 app:// URL（0.05 / 0.25 / 0.5 / 0.75 / 0.95）。
   */
  'project:get-preprocess-meta': (input: {
    id: ProjectId
  }) => Promise<{
    fps: number
    width: number
    height: number
    durationMs: number
    thumbnails: string[]
  } | null>

  // ---- pipeline ----
  'pipeline:start': (input: { projectId: ProjectId; resumeFrom?: StageName }) => Promise<{
    runId: string
  }>
  'pipeline:pause': (input: { projectId: ProjectId }) => Promise<void>
  'pipeline:retry-stage': (input: { projectId: ProjectId; stage: StageName }) => Promise<void>
  /** 全部重跑：清掉所有 stage 状态 + segments/characters/voices/render 产物，从头跑 */
  'pipeline:reset-all': (input: { projectId: ProjectId }) => Promise<void>
  'pipeline:status': (input: { projectId: ProjectId }) => Promise<PipelineStatus>

  // ---- segment ----
  'segment:list': (input: { projectId: ProjectId }) => Promise<Segment[]>
  'segment:update': (input: SegmentPatch) => Promise<void>
  /** v0.4.22 segment 级"使用原音" — true = 该 segment mix-render 用 srcAudioPath 替 TTS */
  'segment:set-use-original-audio': (input: {
    projectId: ProjectId
    segmentId: SegmentId
    useOriginalAudio: boolean
  }) => Promise<void>
  'segment:tts-regenerate': (input: {
    projectId: ProjectId
    segmentId: SegmentId
    reason?: string
  }) => Promise<{ taskId: string }>
  /** 拿到单 segment 的所有资产路径（缩略图 / 原音 / 克隆样本 / TTS 音频 / TTS 输入文本） */
  'segment:assets': (input: {
    projectId: ProjectId
    segmentId: SegmentId
  }) => Promise<SegmentAssets>
  /** 单 segment 重合成：可选覆盖 tgtText/emotion/voiceId/speed，只跑 TTS 不重 mix-render */
  'segment:resynth': (input: {
    projectId: ProjectId
    segmentId: SegmentId
    overrides?: {
      tgtText?: string
      emotion?: string | null
      voiceId?: string
      speed?: number
      emotionIntensity?: number
      /** v0.4.11 音量倍率 [0, 10]——MiniMax t2a_v2 vol 字段 */
      vol?: number
    }
  }) => Promise<{ ok: boolean; newDurMs: number }>
  // ---- character ----
  'character:list': (input: { projectId: ProjectId }) => Promise<Character[]>
  'character:rename': (input: {
    projectId: ProjectId
    characterId: CharacterId
    name: string
  }) => Promise<void>
  'character:reclone': (input: {
    projectId: ProjectId
    characterId: CharacterId
  }) => Promise<void>
  // v0.4.16 P1 "使用原音" 开关：true = mix-render 用 src_audio_path 代替 TTS
  'character:set-use-original-audio': (input: {
    projectId: ProjectId
    characterId: CharacterId
    useOriginalAudio: boolean
  }) => Promise<void>
  // v0.4.17 P2 "复制并复刻" 一步完成：拼接源音 + 调 voice_clone + 写回 voice_id
  // 客户点按钮就完事，不再让手动重跑 voice-clone stage
  'character:reclone-extended': (input: {
    projectId: ProjectId
    characterId: CharacterId
  }) => Promise<{
    ok: true
    samplePath: string
    sourceCount: number
    voiceId: string
    voiceExpiresAt: number | null
  }>

  // ---- voice library ----
  'voice:list': () => Promise<VoiceAsset[]>
  'voice:rename': (input: { voiceId: string; name: string }) => Promise<void>
  'voice:delete': (input: { voiceId: string }) => Promise<void>

  // ---- batch ----
  'batch:enqueue': (input: BatchEnqueueInput) => Promise<{ batchId: BatchId }>
  'batch:status': (input: { batchId?: BatchId }) => Promise<BatchStatus[]>
  'batch:cancel': (input: { batchId: BatchId }) => Promise<void>
}

export type ApiChannel = keyof ApiSurface
export type ApiArg<K extends ApiChannel> = Parameters<ApiSurface[K]>[0]
export type ApiResult<K extends ApiChannel> = Awaited<ReturnType<ApiSurface[K]>>

// Renderer 侧的统一调用形态
export interface ApiBridge {
  invoke<K extends ApiChannel>(channel: K, payload?: ApiArg<K>): Promise<IpcResponse<ApiResult<K>>>
  on<K extends EventChannel>(channel: K, listener: (payload: EventPayload<K>) => void): () => void
}

// 仅占位，由 ./events.ts 重新导出
import type { EventChannel, EventPayload } from './events.js'
