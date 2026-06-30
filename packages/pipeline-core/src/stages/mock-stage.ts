import type { Stage, StageName, StageResult, StageRunContext } from '@dramaprime/core-types'

/**
 * 为 v0.1 阶段使用的 mock stage 工厂——纯模拟，按进度报点 + 报点假成本。
 * 真实实现陆续替换：
 *   preprocess / mix-render → 调 ffmpeg (utilityProcess)
 *   asr-diarize / translate / tts-synth / voice-clone → 调 provider
 *   shot-detect / demix / ocr-assist / cluster → 调 sidecar
 *   align / finalize → main 本地
 */
export function makeMockStage(opts: {
  name: StageName
  kind: Stage['kind']
  /** 模拟总耗时 ms（按进度均匀报） */
  durationMs?: number
  blocking?: boolean
  retries?: number
  /** 模拟产物路径 */
  outputs?: Record<string, string>
  /** 模拟成本 cents */
  costCents?: number
  costUnit?: 'tokens' | 'chars' | 'seconds' | 'requests'
  costModel?: string
  costProvider?: 'MiniMax' | 'volcengine'
}): Stage {
  const {
    name,
    kind,
    durationMs = 1_500,
    blocking = true,
    retries = 2,
    outputs = {},
    costCents = 0,
    costUnit = 'requests',
    costModel = 'mock',
    costProvider = 'MiniMax',
  } = opts

  return {
    name,
    version: 1,
    inputsFrom: [],
    blocking,
    retries,
    kind,
    async run(ctx: StageRunContext): Promise<StageResult> {
      const steps = 10
      const stepMs = Math.max(50, Math.floor(durationMs / steps))
      const t0 = Date.now()
      for (let i = 1; i <= steps; i++) {
        if (ctx.signal.aborted) {
          return {
            kind: 'failed',
            error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
          }
        }
        await new Promise((r) => setTimeout(r, stepMs))
        ctx.reportProgress(Math.round((i / steps) * 100), `${name}: step ${i}/${steps}`)
      }
      if (costCents > 0) {
        ctx.reportCost({
          provider: costProvider,
          model: costModel,
          units: 1,
          unitKind: costUnit,
          cents: costCents,
          ts: Date.now(),
        })
      }
      ctx.logger.info(`${name} done in ${Date.now() - t0}ms`)
      return { kind: 'ok', outputs, durationMs: Date.now() - t0 }
    },
  }
}
