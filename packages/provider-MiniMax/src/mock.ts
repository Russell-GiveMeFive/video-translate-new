import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type {
  ChatInput,
  ChatOutput,
  CloneInput,
  LlmProvider,
  TtsInput,
  TtsOutput,
  TtsProvider,
  VoiceCloneProvider,
} from '@dramaprime/core-types'

/**
 * v0.1 阶段使用的离线 mock provider，让整个 pipeline 不依赖外部网络即可跑通。
 * 真实部署只需把这三个 mock 替换为 MiniMaxLlmProvider / MiniMaxTtsProvider / MiniMaxVoiceCloneProvider
 */

export class MockMiniMaxLlmProvider implements LlmProvider {
  readonly name = 'MiniMax-mock'
  async chat(input: ChatInput): Promise<ChatOutput> {
    const text = '[mock translation] ' + input.messages.at(-1)?.content.slice(0, 80)
    return {
      text,
      usage: { promptTokens: 100, completionTokens: 40 },
      costCents: 1,
      requestId: `mock-${randomUUID()}`,
    }
  }
  estimateCost(_input: ChatInput): number {
    return 1
  }
}

export class MockMiniMaxTtsProvider implements TtsProvider {
  readonly name = 'MiniMax-mock'
  async synthesize(input: TtsInput): Promise<TtsOutput> {
    // 写一个空 wav 文件占位（44 字节最小 WAV header）
    const path = join(tmpdir(), `tts-mock-${randomUUID()}.wav`)
    await writeFile(path, makeSilentWav(0.2))
    return {
      audioPath: path,
      durationMs: Math.max(200, input.text.length * 80),
      costCents: 1,
      requestId: `mock-${randomUUID()}`,
    }
  }
  estimateCost(_input: TtsInput): number {
    return 1
  }
}

export class MockMiniMaxVoiceCloneProvider implements VoiceCloneProvider {
  readonly name = 'MiniMax-mock'
  async upload(_samplePath: string): Promise<{ fileId: string }> {
    return { fileId: `mock-file-${randomUUID()}` }
  }
  async clone(_input: CloneInput): Promise<{ voiceId: string; expiresAt: number }> {
    return { voiceId: `mock-voice-${randomUUID()}`, expiresAt: Date.now() + 168 * 3600 * 1000 }
  }
  async promote(_voiceId: string): Promise<void> {
    return
  }
}

const makeSilentWav = (seconds: number, sampleRate = 32_000): Buffer => {
  const numSamples = Math.floor(seconds * sampleRate)
  const dataSize = numSamples * 2 // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize)
  // RIFF header
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM format
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}
