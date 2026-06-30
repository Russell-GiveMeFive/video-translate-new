import { join } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import {
  Orchestrator,
  makeMockStages,
  type OrchestratorStore,
} from '@dramaprime/pipeline-core'
import type {
  CostEntry,
  ProjectId,
  ProviderRegistry,
  Stage,
  StageName,
  StageResult,
} from '@dramaprime/core-types'
import { ProjectRepo } from '../storage/project-repo.js'
import { StageRepo } from '../storage/stage-repo.js'
import { CostRepo } from '../storage/cost-repo.js'
import { logger } from '../logger.js'
import { realPreprocessStage, realMixRenderStage } from '../stages/ffmpeg-stages.js'
import { asrDiarizeStage, clusterStage } from '../stages/asr-cluster-stages.js'
import { translateStage } from '../stages/translate-stage.js'
import { ttsSynthStage } from '../stages/tts-stage.js'
import { voiceCloneStage } from '../stages/voice-clone-stage.js'
import { alignStage } from '../stages/align-stage.js'
import { subtitleBurnStage } from '../stages/subtitle-stage.js'
import { realDemixStage } from '../stages/demix-stage.js'
// thumbExtractStage v0.5 暂时禁用——让位给 vlm-ocr-stage 占 ocr-assist slot
// 工作台 UI 缩略图后续可从 VLM OCR 抽帧产物里复用
// import { thumbExtractStage } from '../stages/thumb-extract-stage.js'
import { vlmOcrStage } from '../stages/vlm-ocr-stage.js'

export interface InitOrchestratorOpts {
  projectsDir: string
  providers: ProviderRegistry
}

let _orch: Orchestrator | undefined
let _projectsDir = ''

/** 组装最终的 stage 表：从 mock 起步，按"真实化进度"逐个替换 */
const buildStages = (_providers: ProviderRegistry): Record<StageName, Stage> => {
  const stages = makeMockStages()
  // v0.2.a 真实化（ffmpeg）
  stages.preprocess = realPreprocessStage
  stages['mix-render'] = realMixRenderStage
  // v0.2.b 真实化（ASR + 翻译 + TTS）
  stages['asr-diarize'] = asrDiarizeStage
  stages.cluster = clusterStage
  stages.translate = translateStage
  stages['tts-synth'] = ttsSynthStage
  // v0.2.c 真实化（音色克隆）
  stages['voice-clone'] = voiceCloneStage
  // v0.3 真实化（时长对齐）
  stages.align = alignStage
  // v0.4 真实化（字幕生成）
  stages['subtitle-burn'] = subtitleBurnStage
  // v0.4 真实化（demucs 人声分离）—— demucs 没装时优雅 skipped、下游用源音轨兜底
  stages.demix = realDemixStage
  // v0.5 真实化（VLM OCR 字幕识别）—— 用 M3 VLM 识别原片烧录中文字幕的真实时间轴
  // 解决"ASR 切句节奏≠原片字幕节奏，一句中文配多句译文"问题
  // 占用 ocr-assist slot（asr-diarize 之后、cluster 之前——正确依赖顺序）
  // 失败不阻塞，下游沿用 ASR segment 兜底
  //
  // 注：原本占用 ocr-assist 的 thumbExtractStage 暂时禁用（工作台 UI 用，不影响最终视频）
  // 后续 v0.6 可让 vlm-ocr-stage 复用抽帧产物给"工作台 UI"
  stages['ocr-assist'] = vlmOcrStage
  // 剩余 mock 兜底：
  //   - import-precheck（v0.3 接 OCR sidecar）
  //   - shot-detect（v0.3 接 PySceneDetect sidecar）
  //   - ocr-assist（v0.3 接 PaddleOCR sidecar）
  //   - finalize（v0.3 工程包导出）
  return stages
}

export const initOrchestrator = (opts: InitOrchestratorOpts): void => {
  _projectsDir = opts.projectsDir
  if (!existsSync(_projectsDir)) mkdirSync(_projectsDir, { recursive: true })

  const store: OrchestratorStore = {
    async beginStage(projectId: ProjectId, stage: StageName) {
      StageRepo.begin(projectId, stage)
      ProjectRepo.updateStatus(projectId, 'running', stage)
    },
    async finishStage(projectId, stage, result, durationMs) {
      StageRepo.finish(projectId, stage, result, durationMs)
    },
    async recordCost(entry: CostEntry) {
      CostRepo.insert(entry)
      if (entry.projectId) ProjectRepo.addCost(entry.projectId, entry.cents)
    },
    async loadStageStatuses(projectId): Promise<Partial<Record<StageName, StageResult>>> {
      return StageRepo.load(projectId)
    },
  }

  _orch = new Orchestrator({
    store,
    stages: buildStages(opts.providers),
    logger: (projectId, stage) => ({
      info: (msg, ctx) => logger.info({ projectId, stage, ...ctx }, msg),
      warn: (msg, ctx) => logger.warn({ projectId, stage, ...ctx }, msg),
      error: (msg, ctx) => logger.error({ projectId, stage, ...ctx }, msg),
      debug: (msg, ctx) => logger.debug({ projectId, stage, ...ctx }, msg),
    }),
    projectDir: (projectId) => {
      const dir = join(_projectsDir, projectId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      return dir
    },
  })

  _orch.on('finished', ({ projectId, status }) => {
    ProjectRepo.updateStatus(projectId, status, null)
  })
}

export const orchestrator = (): Orchestrator => {
  if (!_orch) throw new Error('orchestrator not initialized')
  return _orch
}

/** 返回项目本地工作目录（含 audio/voices/render/subtitles 等中间产物） */
export const getProjectDir = (projectId: ProjectId): string => {
  if (!_projectsDir) throw new Error('orchestrator not initialized')
  return join(_projectsDir, projectId)
}

export const stopAllPipelines = async (): Promise<void> => {
  // v0.1：暂时没有跨进程任务，调 pause 即可（实际单机使用够用）
}
