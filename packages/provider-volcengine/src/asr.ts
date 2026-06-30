import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type {
  AsrInput,
  AsrOutput,
  AsrProvider,
  AsrUtterance,
} from '@dramaprime/core-types'
import { AppError } from '@dramaprime/core-types'
import {
  decodeFrame,
  encodeAudioChunk,
  encodeFullClientRequest,
  MessageFlags,
  MessageType,
} from './protocol.js'
import type { VolcAsrConfig } from './index.js'

/**
 * 火山引擎流式 ASR 客户端 —— 走 nostream 模式（`bigmodel_nostream`）：
 *   - 文档：https://www.volcengine.com/docs/6561/1354869
 *   - 准确率最高、不需要 TOS、纯 WebSocket
 *   - 适合"已知完整音频，要最高准确率"的场景（恰好是我们短剧用法）
 */
export class VolcAsrProvider implements AsrProvider {
  readonly name = 'volcengine'

  constructor(private cfg: VolcAsrConfig) {}

  async transcribe(input: AsrInput): Promise<AsrOutput> {
    // input.audioPath 必须是 16k mono s16le PCM 的 wav 文件（由 asr-diarize stage 准备）
    const { readFile } = await import('node:fs/promises')
    const wavBuf = await readFile(input.audioPath)
    const pcm = stripWavHeader(wavBuf)

    return this.transcribePcm(pcm, input)
  }

  private async transcribePcm(pcm: Buffer, input: AsrInput): Promise<AsrOutput> {
    const endpoint =
      this.cfg.endpoint ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
    const resourceId = this.cfg.modelId ?? 'volc.seedasr.sauc.duration'
    const requestId = randomUUID()
    const connectId = randomUUID()

    const headers: Record<string, string> = {
      'X-Api-App-Key': this.cfg.appId,
      'X-Api-Access-Key': this.cfg.accessToken,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
      'X-Api-Connect-Id': connectId,
    }

    const ws = new WebSocket(endpoint, { headers })

    // 文档：开启 enable_speaker_info 需 ssd_version='200'；gender/emotion 仅在 nostream 支持
    const configFrame = {
      user: { uid: 'dramaprime-' + randomUUID().slice(0, 8) },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: 16000,
        bits: 16,
        channel: 1,
        language: input.language === 'zh' || !input.language ? 'zh-CN' : input.language,
      },
      request: {
        model_name: 'bigmodel',
        ssd_version: '200',
        enable_itn: true,
        enable_punc: true,
        enable_speaker_info: true,
        enable_gender_detection: true,
        enable_emotion_detection: true,
        show_utterances: true,
      },
    }

    let logId: string | undefined

    return new Promise<AsrOutput>((resolve, reject) => {
      const accumulated: VolcResultPayload = { result: { text: '', utterances: [] }, audio_info: {} }
      let receivedFinal = false
      let sequence = 2 // sequence 1 给 full client request；audio 从 2 开始
      let opened = false

      const cleanup = (): void => {
        try {
          ws.removeAllListeners()
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close()
          }
        } catch {
          /* ignore */
        }
      }

      const handleError = (err: AppError): void => {
        cleanup()
        reject(err)
      }

      ws.on('upgrade', (res) => {
        logId = res.headers['x-tt-logid'] as string | undefined
      })

      ws.on('open', async () => {
        opened = true
        try {
          // 1. 发 full client request
          ws.send(encodeFullClientRequest(configFrame, 1), { binary: true })

          // 2. 分块发音频（200ms 一包 = 16000Hz × 0.2s × 2bytes = 6400 字节）
          const CHUNK_SIZE = 6400 // 200ms @ 16k mono s16le
          const INTERVAL_MS = 100 // 略快于实时，避免服务端等包
          const totalChunks = Math.ceil(pcm.length / CHUNK_SIZE)
          for (let i = 0; i < totalChunks; i++) {
            if (input.signal?.aborted) {
              throw new AppError({
                code: 'pipeline.aborted',
                message: '用户取消',
                retriable: false,
              })
            }
            const start = i * CHUNK_SIZE
            const end = Math.min(pcm.length, start + CHUNK_SIZE)
            const chunk = pcm.subarray(start, end)
            const isLast = i === totalChunks - 1
            ws.send(encodeAudioChunk(chunk, sequence, isLast), { binary: true })
            sequence++
            // 节流（nostream 模式不强求 200ms 精确，但太快服务器可能拒绝）
            if (!isLast) await sleep(INTERVAL_MS)
          }
        } catch (err) {
          handleError(
            err instanceof AppError
              ? err
              : new AppError({
                  code: 'provider.network',
                  message: `volc asr send: ${(err as Error).message}`,
                  retriable: true,
                }),
          )
        }
      })

      ws.on('message', (data: Buffer) => {
        try {
          const frame = decodeFrame(data)
          if (frame.messageType === MessageType.ServerError) {
            const msg =
              typeof frame.payload === 'object' && frame.payload !== null
                ? JSON.stringify(frame.payload)
                : String(frame.payload ?? '')
            handleError(
              new AppError({
                code:
                  frame.errorCode === 55000031
                    ? 'provider.rate-limited'
                    : (frame.errorCode ?? 0) >= 5_500_0000
                      ? 'provider.upstream-5xx'
                      : 'provider.bad-request',
                message: `volc asr error ${frame.errorCode}: ${msg.slice(0, 200)} [logid=${logId ?? '?'}]`,
                retriable: frame.errorCode === 55000031,
                context: { errorCode: frame.errorCode, logId },
              }),
            )
            return
          }

          if (frame.messageType === MessageType.FullServerResponse) {
            const isLast =
              frame.flags === MessageFlags.LastPacketNegSeq ||
              frame.flags === MessageFlags.LastPacketNoSeq

            if (frame.payload && typeof frame.payload === 'object' && !Buffer.isBuffer(frame.payload)) {
              // 临时调试：保留最终帧原始内容（含 speaker_id 字段位置探索）
              if (isLast) {
                try {
                  // eslint-disable-next-line no-console
                  console.log(
                    '[VolcAsr/final-frame]',
                    JSON.stringify(frame.payload, null, 2).slice(0, 4000),
                  )
                } catch {
                  /* ignore */
                }
              }
              mergeResult(accumulated, frame.payload as VolcResultPayload)
            }

            if (isLast) {
              receivedFinal = true
              const out = toAsrOutput(accumulated, pcm.length, logId)
              cleanup()
              resolve(out)
            }
          }
        } catch (err) {
          handleError(
            new AppError({
              code: 'provider.bad-request',
              message: `volc asr decode: ${(err as Error).message} [logid=${logId ?? '?'}]`,
              retriable: false,
            }),
          )
        }
      })

      ws.on('error', (err) => {
        handleError(
          new AppError({
            code: 'provider.network',
            message: `volc asr ws error: ${err.message} [logid=${logId ?? '?'}]`,
            retriable: true,
          }),
        )
      })

      ws.on('close', (code, reason) => {
        if (!receivedFinal) {
          handleError(
            new AppError({
              code: 'provider.network',
              message: `volc asr ws closed before final (code=${code}, reason=${reason?.toString()}) [logid=${logId ?? '?'}]`,
              retriable: true,
            }),
          )
        }
      })

      // 整体超时（90s 短剧 + 余量）
      setTimeout(() => {
        if (!receivedFinal) {
          handleError(
            new AppError({
              code: 'provider.timeout',
              message: `volc asr 整体超时 (>120s) [logid=${logId ?? '?'}] opened=${opened}`,
              retriable: true,
            }),
          )
        }
      }, 120_000)
    })
  }

  estimateCost(input: AsrInput): number {
    // 占位：~¥0.01/s ≈ 1 cent/s；具体看你账户阶梯
    return Math.max(1, Math.round(estimateAudioSeconds(input.audioPath)))
  }
}

// ── helpers ──────────────────────────────────────────────────────────

interface VolcUtterance {
  text?: string
  start_time?: number
  end_time?: number
  definite?: boolean
  /** speaker 信息可能出现在以下任一位置（按观察到的火山真实响应不同） */
  speaker_id?: string | number
  spk_id?: string | number
  speaker?: string | number
  words?: Array<{
    start_time?: number
    end_time?: number
    text?: string
    blank_duration?: number
    speaker_id?: string | number
    spk_id?: string | number
  }>
  additions?: {
    gender?: string
    emotion?: string
    speech_rate?: number
    volume?: number
    lid_lang?: string
    speaker_id?: string | number
    spk_id?: string | number
    speaker?: string | number
  }
}

interface VolcResultPayload {
  result?: {
    text?: string
    utterances?: VolcUtterance[]
  }
  audio_info?: { duration?: number }
}

/**
 * 合并增量帧：火山是"全量返回"模式（默认 result_type=full），
 * 每帧都包含从 0 到当前的所有 utterances；新帧直接覆盖旧的即可。
 */
const mergeResult = (acc: VolcResultPayload, frame: VolcResultPayload): void => {
  if (frame.result) {
    if (typeof frame.result.text === 'string') {
      acc.result!.text = frame.result.text
    }
    if (Array.isArray(frame.result.utterances)) {
      acc.result!.utterances = frame.result.utterances
    }
  }
  if (frame.audio_info?.duration) {
    acc.audio_info = { duration: frame.audio_info.duration }
  }
}

const toAsrOutput = (
  acc: VolcResultPayload,
  pcmBytes: number,
  requestId: string | undefined,
): AsrOutput => {
  const utterances: AsrUtterance[] = (acc.result?.utterances ?? [])
    .filter((u) => u.definite !== false) // 只保留 definite（最终）句
    .map((u) => ({
      startMs: u.start_time ?? 0,
      endMs: u.end_time ?? 0,
      text: u.text ?? '',
      confidence: 0.95,
      // 火山可能把 speaker_id 放在 utterance 顶层 / additions / words 里
      // 这里兜底查多个位置；都没有时用"按 word 多数派"推断 / 最终回退 'unknown'
      speakerId: extractSpeakerId(u),
      gender:
        u.additions?.gender === 'male' || u.additions?.gender === 'female'
          ? u.additions.gender
          : undefined,
      emotion: u.additions?.emotion ?? undefined,
      speechRate: u.additions?.speech_rate ?? undefined,
      volume: u.additions?.volume ?? undefined,
      // 词级时间戳——用于上层句段细分（按标点 + 长度阈值）
      words: Array.isArray(u.words)
        ? u.words
            .filter((w) => typeof w.text === 'string' && w.text.length > 0)
            .map((w) => ({
              startMs: w.start_time ?? 0,
              endMs: w.end_time ?? 0,
              text: w.text!,
              blankBeforeMs: w.blank_duration ?? undefined,
            }))
        : undefined,
    }))

  // 聚合 speakers
  const speakerStat = new Map<string, { sampleCount: number; totalDurMs: number }>()
  for (const u of utterances) {
    const s = speakerStat.get(u.speakerId) ?? { sampleCount: 0, totalDurMs: 0 }
    s.sampleCount += 1
    s.totalDurMs += Math.max(0, u.endMs - u.startMs)
    speakerStat.set(u.speakerId, s)
  }
  const speakers = Array.from(speakerStat.entries()).map(([id, v]) => ({
    id,
    sampleCount: v.sampleCount,
    totalDurMs: v.totalDurMs,
  }))

  // 估计成本（音频秒数 × 1 cent；以官方为准）
  const durSec = (acc.audio_info?.duration ?? Math.round((pcmBytes / 2 / 16000) * 1000)) / 1000

  return {
    language: 'zh',
    utterances,
    speakers,
    costCents: Math.ceil(durSec),
    requestId,
  }
}

/** 去掉 WAV 文件头（44 字节标准 PCM RIFF header）；若不是 wav 直接返回 */
const stripWavHeader = (buf: Buffer): Buffer => {
  if (buf.length < 44 || buf.subarray(0, 4).toString() !== 'RIFF') return buf
  // 简化：找 "data" chunk 后面的实际 PCM
  const dataIdx = buf.indexOf(Buffer.from('data'))
  if (dataIdx < 0 || dataIdx + 8 > buf.length) return buf.subarray(44)
  return buf.subarray(dataIdx + 8)
}

/**
 * 从一个 utterance 提取 speaker_id：火山把它可能放在多个位置，依次兜底：
 *   1. 顶层 speaker_id / spk_id / speaker
 *   2. additions.speaker_id / spk_id / speaker
 *   3. words[] 多数派（按 word.speaker_id / spk_id 投票）
 *   4. 都没有 → 'unknown'
 */
const extractSpeakerId = (u: VolcUtterance): string => {
  const fromTop = u.speaker_id ?? u.spk_id ?? u.speaker
  if (fromTop !== undefined && fromTop !== null && String(fromTop) !== '') {
    return String(fromTop)
  }
  const fromAdditions =
    u.additions?.speaker_id ?? u.additions?.spk_id ?? u.additions?.speaker
  if (fromAdditions !== undefined && fromAdditions !== null && String(fromAdditions) !== '') {
    return String(fromAdditions)
  }
  if (Array.isArray(u.words) && u.words.length > 0) {
    const tallies = new Map<string, number>()
    for (const w of u.words) {
      const wId = w.speaker_id ?? w.spk_id
      if (wId === undefined || wId === null) continue
      const key = String(wId)
      tallies.set(key, (tallies.get(key) ?? 0) + 1)
    }
    if (tallies.size > 0) {
      let bestKey = 'unknown'
      let bestCount = 0
      for (const [k, c] of tallies) {
        if (c > bestCount) {
          bestKey = k
          bestCount = c
        }
      }
      return bestKey
    }
  }
  return 'unknown'
}

const estimateAudioSeconds = (_path: string): number => 30 // 兜底估算

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
