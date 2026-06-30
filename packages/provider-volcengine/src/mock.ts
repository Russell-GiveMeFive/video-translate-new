import { randomUUID } from 'node:crypto'
import type { AsrInput, AsrOutput, AsrProvider } from '@dramaprime/core-types'

/**
 * 离线 mock：根据音频假设产生 3 个 speaker、12 个 utterance
 * （让下游 cluster / clone / translate 有数据可用）
 */
export class MockVolcAsrProvider implements AsrProvider {
  readonly name = 'volcengine-mock'

  async transcribe(_input: AsrInput): Promise<AsrOutput> {
    const utterances = Array.from({ length: 12 }, (_, i) => ({
      startMs: i * 7_000,
      endMs: i * 7_000 + 6_500,
      text: MOCK_LINES[i % MOCK_LINES.length]!,
      confidence: 0.92,
      speakerId: `spk_${i % 3}`,
    }))
    return {
      language: 'zh',
      utterances,
      speakers: [
        { id: 'spk_0', sampleCount: 4, totalDurMs: 26_000 },
        { id: 'spk_1', sampleCount: 4, totalDurMs: 26_000 },
        { id: 'spk_2', sampleCount: 4, totalDurMs: 26_000 },
      ],
      costCents: 90,
      requestId: `mock-${randomUUID()}`,
    }
  }

  estimateCost(_input: AsrInput): number {
    return 90
  }
}

const MOCK_LINES = [
  '你今天怎么这样对我',
  '我不是故意的，别生气',
  '可是我已经受不了了',
  '给我一次机会好不好',
  '这次我真的会改',
  '我不相信你',
  '你听我解释',
  '不用解释了',
  '求求你',
  '走吧',
  '我会让你后悔的',
  '随便你',
]
