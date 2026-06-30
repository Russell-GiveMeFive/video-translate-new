import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { handle, type IpcContext } from './index.js'
import { getProjectDir, orchestrator } from '../orchestrator/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { StageRepo } from '../storage/stage-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { CostRepo } from '../storage/cost-repo.js'
import { ALL_STAGES, type PipelineStatus, type StageName, type StageRecord } from '@dramaprime/core-types'
import { logger } from '../logger.js'

let bridgeWired = false

/** stage → 该 stage 重跑时需要级联清掉的"项目目录下"中间产物子目录 */
const STAGE_ARTIFACT_DIRS: Record<StageName, string[]> = {
  preprocess: ['preprocess', 'audio', 'normalized'],
  'import-precheck': [],
  'shot-detect': ['shots'],
  demix: ['stems'],
  'asr-diarize': [], // segments 走 DB 清理（stems/vocals-asr.wav 跟 demix 一起清）
  'ocr-assist': ['ocr'],
  cluster: [], // characters 走 DB 清理
  'voice-clone': ['voices'],
  translate: [],
  'tts-synth': ['tts'],
  align: ['align'],
  'subtitle-burn': ['subtitles'],
  'mix-render': ['render'],
  finalize: ['export'],
}

/** 清理指定 stage 及其下游的所有产物目录（"重跑"核心动作） */
const wipeArtifactsCascade = async (
  projectId: string,
  fromStage: StageName,
): Promise<void> => {
  const projectDir = getProjectDir(projectId as any)
  const idx = ALL_STAGES.indexOf(fromStage)
  if (idx < 0) return
  const downstream = ALL_STAGES.slice(idx)
  for (const s of downstream) {
    for (const sub of STAGE_ARTIFACT_DIRS[s]) {
      const dir = join(projectDir, sub)
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true }).catch((err) => {
          logger.warn({ projectId, stage: s, dir, err: String(err) }, 'wipe artifact dir failed')
        })
      }
    }
  }
}

export const registerPipelineIpc = (ctx: IpcContext): void => {
  setupBridge(ctx)

  handle('pipeline:start', async ({ projectId, resumeFrom }) => {
    const runId = randomUUID()
    logger.info({ projectId, resumeFrom }, 'pipeline:start')
    void orchestrator()
      .run(projectId, { resumeFrom })
      .catch((err) => {
        logger.error(
          { projectId, err: String((err as Error)?.message ?? err) },
          'pipeline run rejected',
        )
      })
    return { runId }
  })

  handle('pipeline:pause', async ({ projectId }) => {
    logger.info({ projectId }, 'pipeline:pause')
    await orchestrator().pause(projectId)
  })

  handle('pipeline:retry-stage', async ({ projectId, stage }) => {
    logger.info({ projectId, stage }, 'pipeline:retry-stage (cascade)')
    // 1) 删 stage 状态：本 stage + 所有下游 stage
    StageRepo.resetCascade(projectId, stage, ALL_STAGES)
    // 2) 删 DB 派生数据（视 stage 而定）
    //    - asr-diarize 重跑：segments 全清（cluster 会重建 characters 也跟着清）
    //    - cluster 重跑：characters 清，segment.character_id 在 cluster 阶段会重写
    //    - voice-clone 重跑：清 character 的 voice_id 不必硬清，下次 setVoice 会覆盖
    if (stage === 'preprocess' || stage === 'asr-diarize') {
      SegmentRepo.clearForProject(projectId)
      CharacterRepo.clearForProject(projectId)
    } else if (stage === 'cluster') {
      CharacterRepo.clearForProject(projectId)
    }
    // 3) 删文件产物
    await wipeArtifactsCascade(projectId, stage)
    // 4) 从该 stage 起重跑
    void orchestrator()
      .run(projectId, { resumeFrom: stage })
      .catch((err) => {
        logger.error(
          { projectId, stage, err: String((err as Error)?.message ?? err) },
          'pipeline retry-stage rejected',
        )
      })
  })

  handle('pipeline:reset-all', async ({ projectId }) => {
    logger.info({ projectId }, 'pipeline:reset-all')
    // 1) 删全部 stage 状态
    StageRepo.clearAll(projectId)
    // 2) 删 DB 派生数据（segments + characters）
    SegmentRepo.clearForProject(projectId)
    CharacterRepo.clearForProject(projectId)
    // 3) 删所有中间产物目录
    await wipeArtifactsCascade(projectId, ALL_STAGES[0]!)
    // 4) 项目状态置回 created
    ProjectRepo.updateStatus(projectId, 'created', null)
    // 5) 从头跑
    void orchestrator()
      .run(projectId)
      .catch((err) => {
        logger.error(
          { projectId, err: String((err as Error)?.message ?? err) },
          'pipeline reset-all rejected',
        )
      })
  })

  handle('pipeline:status', async ({ projectId }): Promise<PipelineStatus> => {
    const proj = ProjectRepo.get(projectId)
    const stagesMap = StageRepo.load(projectId)
    const stages: StageRecord[] = ALL_STAGES.map((s) => {
      const rec = stagesMap[s]
      return {
        stage: s,
        status: rec?.kind === 'ok' ? 'done' : rec?.kind === 'failed' ? 'failed' : 'pending',
        attempts: 0,
        startedAt: null,
        endedAt: null,
        durationMs: rec?.kind === 'ok' ? rec.durationMs : null,
        costCents: 0,
        outputs: rec?.kind === 'ok' ? rec.outputs : {},
        error: rec?.kind === 'failed' ? rec.error.message : null,
      }
    })
    return {
      projectId,
      status: proj.status,
      currentStage: proj.currentStage,
      stages,
      etaMs: null,
      costTotalCents: CostRepo.totalCents(projectId),
    }
  })
}

const setupBridge = (ctx: IpcContext): void => {
  if (bridgeWired) return
  bridgeWired = true

  const send = (channel: string, payload: unknown): void => {
    const w = ctx.getMainWindow()
    if (!w || w.isDestroyed()) return
    w.webContents.send(channel, payload)
  }

  orchestrator().on('progress', (p) => send('event:pipeline:progress', p))

  orchestrator().on('stage-done', (p) => {
    logger.info(
      {
        projectId: p.projectId,
        stage: p.stage,
        durationMs: p.durationMs,
        outputs: Object.keys(p.outputs),
      },
      `stage done: ${p.stage}`,
    )
    send('event:pipeline:stage-done', p)
  })

  orchestrator().on('error', (p) => {
    // ★ 关键修复：stage 失败时把完整错误打到 main 终端 + 文件日志
    logger.error(
      {
        projectId: p.projectId,
        stage: p.stage,
        code: p.error.code,
        retriable: p.error.retriable,
        retryAfterMs: p.error.retryAfterMs,
        context: p.error.context,
        cause: p.error.cause,
      },
      `stage FAILED: ${p.stage} — ${p.error.message}`,
    )
    send('event:pipeline:error', p)
  })

  orchestrator().on('finished', (p) => {
    logger.info(
      { projectId: p.projectId, status: p.status, totalCostCents: p.totalCostCents },
      `pipeline finished: ${p.status}`,
    )
    send('event:pipeline:finished', p)
  })
}

