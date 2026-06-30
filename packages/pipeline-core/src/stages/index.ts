import type { Stage, StageName } from '@dramaprime/core-types'
import { makeMockStage } from './mock-stage.js'

/**
 * 14 个 mock stage 集合——v0.1 阶段用，让 UI 端到端能跑通。
 * 每个 stage 真实实现到位后，从这里逐个替换。
 */
export function makeMockStages(): Record<StageName, Stage> {
  return {
    preprocess: makeMockStage({
      name: 'preprocess',
      kind: 'utility',
      durationMs: 800,
      outputs: { metadata: 'preprocess/metadata.json', thumbs: 'preprocess/thumbs/' },
    }),
    'import-precheck': makeMockStage({
      name: 'import-precheck',
      kind: 'utility',
      durationMs: 400,
      blocking: false,
      outputs: { precheck: 'preprocess/precheck.json' },
    }),
    'shot-detect': makeMockStage({
      name: 'shot-detect',
      kind: 'sidecar',
      durationMs: 600,
      blocking: false,
      outputs: { shots: 'preprocess/shots.json' },
    }),
    demix: makeMockStage({
      name: 'demix',
      kind: 'sidecar',
      durationMs: 2_500,
      outputs: { vocals: 'stems/vocals.wav', music: 'stems/music.wav' },
    }),
    'asr-diarize': makeMockStage({
      name: 'asr-diarize',
      kind: 'provider',
      durationMs: 2_000,
      outputs: { asr: 'asr.json' },
      costCents: 90,
      costUnit: 'seconds',
      costProvider: 'volcengine',
      costModel: 'volc-asr',
    }),
    'ocr-assist': makeMockStage({
      name: 'ocr-assist',
      kind: 'sidecar',
      durationMs: 1_200,
      blocking: false,
      outputs: { ocr: 'ocr.json' },
    }),
    cluster: makeMockStage({
      name: 'cluster',
      kind: 'main',
      durationMs: 400,
      outputs: { characters: 'characters.json' },
    }),
    'voice-clone': makeMockStage({
      name: 'voice-clone',
      kind: 'provider',
      durationMs: 1_500,
      outputs: { voices: 'voices/' },
      costProvider: 'MiniMax',
      costModel: 'voice-clone',
    }),
    translate: makeMockStage({
      name: 'translate',
      kind: 'provider',
      durationMs: 2_000,
      outputs: { translations: 'translations.json' },
      costCents: 8,
      costUnit: 'tokens',
      costProvider: 'MiniMax',
      costModel: 'MiniMax-M3',
    }),
    'tts-synth': makeMockStage({
      name: 'tts-synth',
      kind: 'provider',
      durationMs: 3_000,
      outputs: { tts: 'tts/' },
      costCents: 2,
      costUnit: 'chars',
      costProvider: 'MiniMax',
      costModel: 'speech-2.8-hd',
    }),
    align: makeMockStage({
      name: 'align',
      kind: 'main',
      durationMs: 800,
      outputs: { align: 'align.json' },
    }),
    'subtitle-burn': makeMockStage({
      name: 'subtitle-burn',
      kind: 'utility',
      durationMs: 600,
      blocking: false,
      outputs: { subs: 'subs/out.ass' },
    }),
    'mix-render': makeMockStage({
      name: 'mix-render',
      kind: 'utility',
      durationMs: 3_500,
      outputs: { render: 'render/out.mp4' },
    }),
    finalize: makeMockStage({
      name: 'finalize',
      kind: 'main',
      durationMs: 200,
      outputs: { manifest: 'manifest.json' },
    }),
  }
}

export { makeMockStage } from './mock-stage.js'
