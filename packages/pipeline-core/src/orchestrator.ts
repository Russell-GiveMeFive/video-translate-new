import { EventEmitter } from 'node:events'
import {
  ALL_STAGES,
  AppError,
  normalizeError,
  type Stage,
  type StageName,
  type StageResult,
  type StageRunContext,
  type ProjectId,
  type CostEntry,
} from '@dramaprime/core-types'
import { withRetry } from './retry.js'

export interface OrchestratorDeps {
  /** 加载 / 写回 stage 记录的持久化层（由 main 实现） */
  store: OrchestratorStore
  /** 14 个 stage 的具体实现，外部注入 */
  stages: Record<StageName, Stage>
  /** 项目级 logger 工厂 */
  logger: (projectId: ProjectId, stage: StageName) => StageRunContext['logger']
  /** stage 输出根目录 */
  projectDir: (projectId: ProjectId) => string
}

export interface OrchestratorStore {
  beginStage(projectId: ProjectId, stage: StageName): Promise<void>
  finishStage(
    projectId: ProjectId,
    stage: StageName,
    result: StageResult,
    durationMs: number,
  ): Promise<void>
  recordCost(entry: CostEntry): Promise<void>
  loadStageStatuses(projectId: ProjectId): Promise<Partial<Record<StageName, StageResult>>>
}

export interface RunOptions {
  resumeFrom?: StageName
  /** 跑到该 stage 即停（用于"只跑到 ASR"等开发场景） */
  stopAfter?: StageName
}

type Listener<T> = (payload: T) => void

export interface OrchestratorEvents {
  progress: {
    projectId: ProjectId
    stage: StageName
    percent: number
    message?: string
    etaMs: number | null
    costDeltaCents: number
  }
  'stage-done': {
    projectId: ProjectId
    stage: StageName
    outputs: Record<string, string>
    durationMs: number
  }
  error: { projectId: ProjectId; stage: StageName; error: ReturnType<typeof normalizeError> }
  finished: { projectId: ProjectId; status: 'done' | 'failed'; totalCostCents: number }
}

export class Orchestrator {
  private emitter = new EventEmitter()
  private running = new Map<ProjectId, AbortController>()
  private costAccum = new Map<ProjectId, number>()

  constructor(private deps: OrchestratorDeps) {}

  on<K extends keyof OrchestratorEvents>(
    event: K,
    listener: Listener<OrchestratorEvents[K]>,
  ): () => void {
    this.emitter.on(event, listener as any)
    return () => this.emitter.off(event, listener as any)
  }

  isRunning(projectId: ProjectId): boolean {
    return this.running.has(projectId)
  }

  async pause(projectId: ProjectId): Promise<void> {
    this.running.get(projectId)?.abort()
  }

  async run(projectId: ProjectId, opts: RunOptions = {}): Promise<void> {
    if (this.running.has(projectId)) {
      throw new AppError({
        code: 'user.invalid-input',
        message: '项目正在运行中',
        retriable: false,
      })
    }
    const controller = new AbortController()
    this.running.set(projectId, controller)
    this.costAccum.set(projectId, 0)

    const persisted = await this.deps.store.loadStageStatuses(projectId)
    const plan = this.planStages(persisted, opts)
    let finalStatus: 'done' | 'failed' = 'done'

    try {
      for (const stage of plan) {
        if (controller.signal.aborted) {
          finalStatus = 'failed'
          break
        }
        const t0 = Date.now()
        await this.deps.store.beginStage(projectId, stage.name)
        const ctx = this.buildCtx(projectId, stage, controller.signal)

        let result: StageResult
        try {
          result = await withRetry(
            () => stage.run(ctx),
            { retries: stage.retries },
            controller.signal,
          )
        } catch (err) {
          result = { kind: 'failed', error: normalizeError(err) }
        }

        const durationMs = Date.now() - t0
        await this.deps.store.finishStage(projectId, stage.name, result, durationMs)

        if (result.kind === 'ok') {
          this.emit('stage-done', {
            projectId,
            stage: stage.name,
            outputs: result.outputs,
            durationMs,
          })
        } else if (result.kind === 'failed') {
          this.emit('error', { projectId, stage: stage.name, error: result.error })
          if (stage.blocking) {
            finalStatus = 'failed'
            break
          }
        }

        if (opts.stopAfter === stage.name) break
      }
    } finally {
      this.running.delete(projectId)
      this.emit('finished', {
        projectId,
        status: finalStatus,
        totalCostCents: this.costAccum.get(projectId) ?? 0,
      })
      this.costAccum.delete(projectId)
    }
  }

  private planStages(
    persisted: Partial<Record<StageName, StageResult>>,
    opts: RunOptions,
  ): Stage[] {
    const startIdx = opts.resumeFrom ? ALL_STAGES.indexOf(opts.resumeFrom) : 0
    const ordered: Stage[] = []
    for (let i = startIdx; i < ALL_STAGES.length; i++) {
      const name = ALL_STAGES[i]!
      const stage = this.deps.stages[name]
      const prev = persisted[name]
      // 已经成功且未要求 resumeFrom → 跳过
      if (prev?.kind === 'ok' && opts.resumeFrom !== name) continue
      ordered.push(stage)
    }
    return ordered
  }

  private buildCtx(
    projectId: ProjectId,
    stage: Stage,
    signal: AbortSignal,
  ): StageRunContext {
    return {
      projectId,
      projectDir: this.deps.projectDir(projectId),
      signal,
      logger: this.deps.logger(projectId, stage.name),
      reportProgress: (percent: number, message?: string) => {
        this.emit('progress', {
          projectId,
          stage: stage.name,
          percent,
          message,
          etaMs: null,
          costDeltaCents: 0,
        })
      },
      reportCost: (delta: CostEntry) => {
        const cur = this.costAccum.get(projectId) ?? 0
        this.costAccum.set(projectId, cur + delta.cents)
        // 异步落库
        void this.deps.store.recordCost(delta).catch(() => {})
      },
    }
  }

  private emit<K extends keyof OrchestratorEvents>(
    event: K,
    payload: OrchestratorEvents[K],
  ): void {
    this.emitter.emit(event, payload)
  }
}
