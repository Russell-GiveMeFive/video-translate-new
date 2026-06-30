import type { ProjectId, StageName } from './domain.js'
import type { NormalizedError } from './errors.js'

/**
 * Main → Renderer 事件总线
 * Renderer 通过 `window.api.on(channel, cb)` 订阅；返回 unsubscribe 函数
 */
export type EventMap = {
  'event:pipeline:progress': {
    projectId: ProjectId
    stage: StageName
    percent: number
    message?: string
    etaMs: number | null
    costDeltaCents: number
  }
  'event:pipeline:stage-done': {
    projectId: ProjectId
    stage: StageName
    outputs: Record<string, string>
    durationMs: number
  }
  'event:pipeline:error': {
    projectId: ProjectId
    stage: StageName
    error: NormalizedError
  }
  'event:pipeline:finished': {
    projectId: ProjectId
    status: 'done' | 'failed'
    totalCostCents: number
  }
  'event:voice:expiring': {
    voiceId: string
    expireAt: number
    hoursLeft: number
  }
  'event:provider:health': {
    provider: 'MiniMax' | 'volcengine'
    healthy: boolean
    latencyMs: number
  }
  'event:batch:item-done': {
    batchId: string
    projectId: ProjectId
    status: 'done' | 'failed'
  }
}

export type EventChannel = keyof EventMap
export type EventPayload<K extends EventChannel> = EventMap[K]
