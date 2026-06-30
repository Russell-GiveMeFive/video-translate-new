import type { StageName, StageStatus, CostEntry } from './domain.js'
import type { NormalizedError } from './errors.js'

export interface StageRunContext {
  projectId: string
  projectDir: string
  signal: AbortSignal
  reportProgress: (percent: number, message?: string) => void
  reportCost: (delta: CostEntry) => void
  logger: StageLogger
}

export interface StageLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void
  warn: (msg: string, ctx?: Record<string, unknown>) => void
  error: (msg: string, ctx?: Record<string, unknown>) => void
  debug: (msg: string, ctx?: Record<string, unknown>) => void
}

export type StageResult =
  | { kind: 'ok'; outputs: Record<string, string>; durationMs: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: NormalizedError }

export interface Stage {
  name: StageName
  version: number
  /** 上游依赖的 stage（用于决定运行顺序与缓存失效） */
  inputsFrom: StageName[]
  /** 该 stage 失败是否阻塞下游 */
  blocking: boolean
  /** 最大重试次数 */
  retries: number
  /** 类型：决定调度位置（main / utility / sidecar / provider） */
  kind: 'main' | 'utility' | 'sidecar' | 'provider'
  /** 实际执行函数 */
  run(ctx: StageRunContext): Promise<StageResult>
}

export type StageStateMap = Record<StageName, StageStatus>
