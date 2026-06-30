import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { TtsInput, TtsOutput, TtsProvider } from '@dramaprime/core-types'
import { AppError } from '@dramaprime/core-types'
import {
  buildJsonHeaders,
  MINIMAX_DEFAULT_TIMEOUT_MS,
  resolveBaseUrl,
  type MiniMaxConfig,
} from './config.js'

/**
 * MiniMax Speech-2.8 同步 T2A v2
 *   POST {baseUrl}/v1/t2a_v2
 *
 * 关键细节（来自官方文档）：
 *   - voice_setting / audio_setting 是嵌套 object，不是顶层字段
 *   - 默认返回 hex 编码的音频（data.audio），不是 base64
 *   - extra_info.audio_length 是毫秒级时长
 *   - base_resp.status_code === 0 才是成功（除 HTTP 200 外还要查）
 */
export class MiniMaxTtsProvider implements TtsProvider {
  readonly name = 'MiniMax'

  constructor(
    private cfg: MiniMaxConfig,
    private outputDir: string = tmpdir(),
  ) {}

  async synthesize(input: TtsInput): Promise<TtsOutput> {
    const format = input.format ?? 'mp3' // 用 mp3 体积小；align 阶段需要 wav 再 ffmpeg 转
    // emotion mapping：Volcano 给的值不全对得上 MiniMax 接受值
    // MiniMax 文档：happy | sad | angry | fearful | disgusted | surprised | neutral
    // Volcano 给：    happy | sad | angry | fear    | disgust   | surprise  | neutral
    const mappedEmotion = mapEmotionToMinimax(input.emotion)

    const buildBody = (emotion: string | undefined): Record<string, unknown> => ({
      model: input.model ?? 'speech-2.8-hd',
      text: input.text,
      stream: false,
      voice_setting: {
        voice_id: input.voiceId,
        speed: input.speed ?? 1.0,
        vol: input.vol ?? 1.0,
        // ★ v0.4.12 pitch 必须是 integer（MiniMax OpenAPI 写明 type: integer）
        // 之前传 Math.round(merged.pitch) 是小数 — API 收到后类型不匹配可能忽略
        pitch: input.pitch != null ? Math.round(input.pitch) : 0,
        ...(emotion ? { emotion } : {}),
        // MiniMax emotion_intensity：0.5-2.0，默认 1.0，>1 更夸张
        // 短剧 dubbing 默认 1.5 让情绪更饱满；调用方可覆盖
        // ⚠️ 与 voice_modify.intensity 同时存在可能互相干扰失真——调用方按需选用其一
        ...(emotion && input.emotionIntensity != null
          ? { emotion_intensity: clampIntensity(input.emotionIntensity) }
          : {}),
      },
      audio_setting: {
        sample_rate: input.sampleRate ?? 32_000,
        bitrate: 128_000,
        format,
        channel: 1,
      },
      // ★ v0.4.6 补齐客户官方 curl 里的 3 个字段（之前缺这些可能让 MiniMax 走默认/降级路径）
      pronunciation_dict: { tone: [] },
      subtitle_enable: false,
      output_format: 'hex',
      // ★ v0.4.12 voice_modify 三个字段全是 integer（OpenAPI 写明 type: integer）
      // 不做 round 会被 MiniMax 当成非法类型 → 字段被丢弃
      ...(input.voiceModify ? {
        voice_modify: {
          ...(input.voiceModify.pitch != null ? { pitch: Math.round(input.voiceModify.pitch) } : {}),
          ...(input.voiceModify.intensity != null ? { intensity: Math.round(input.voiceModify.intensity) } : {}),
          ...(input.voiceModify.timbre != null ? { timbre: Math.round(input.voiceModify.timbre) } : {}),
          ...(input.voiceModify.sound_effects ? { sound_effects: input.voiceModify.sound_effects } : {}),
        }
      } : {}),
      ...(input.languageBoost ? { language_boost: input.languageBoost } : {}),
      ...(input.englishNormalization ? { english_normalization: true } : {}),
    })

    const url = `${resolveBaseUrl(this.cfg)}/v1/t2a_v2`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? MINIMAX_DEFAULT_TIMEOUT_MS,
    )
    input.signal?.addEventListener('abort', () => controller.abort())

    const tryRequest = async (
      body: Record<string, unknown>,
    ): Promise<T2AResponse> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: buildJsonHeaders(this.cfg),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw httpError(res.status, await res.text())
      }
      return (await res.json()) as T2AResponse
    }

    try {
      let data = await tryRequest(buildBody(mappedEmotion))

      // MiniMax emotion 字段对某些 voice_id / model 不支持，会报 2013 invalid params
      // 这时去掉 emotion 重试一次——情绪丢了但至少有声音
      if (
        data.base_resp &&
        data.base_resp.status_code === 2013 &&
        mappedEmotion &&
        /emotion/i.test(data.base_resp.status_msg ?? '')
      ) {
        data = await tryRequest(buildBody(undefined))
      }

      if (data.base_resp && data.base_resp.status_code !== 0) {
        throw new AppError({
          code: data.base_resp.status_code === 1002 ? 'provider.rate-limited' : 'provider.bad-request',
          message: `MiniMax TTS: ${data.base_resp.status_msg ?? 'unknown error'} (${data.base_resp.status_code})`,
          retriable: data.base_resp.status_code === 1002,
          context: { trace_id: data.trace_id, code: data.base_resp.status_code },
        })
      }
      const hex = data.data?.audio
      if (!hex) {
        throw new AppError({
          code: 'provider.bad-request',
          message: 'MiniMax TTS 响应缺少 data.audio',
          retriable: false,
          context: { trace_id: data.trace_id },
        })
      }
      const audioBuf = Buffer.from(hex, 'hex')
      const audioPath = await this.writeAudio(audioBuf, format)
      const durationMs = data.extra_info?.audio_length ?? estimateDurationMs(input.text)
      const chars = data.extra_info?.usage_characters ?? input.text.length
      return {
        audioPath,
        durationMs,
        costCents: estimateTtsCost(chars, (input.model ?? 'speech-2.8-hd') as string),
        requestId: data.trace_id,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  estimateCost(input: TtsInput): number {
    return estimateTtsCost(input.text.length, input.model ?? 'speech-2.8-hd')
  }

  private async writeAudio(buf: Buffer, format: string): Promise<string> {
    if (!existsSync(this.outputDir)) await mkdir(this.outputDir, { recursive: true })
    const path = join(this.outputDir, `tts-${randomUUID()}.${format}`)
    if (!existsSync(dirname(path))) await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buf)
    return path
  }
}

interface T2AResponse {
  data?: { audio?: string; status?: number; subtitle_file?: string }
  trace_id?: string
  extra_info?: {
    audio_length?: number // ms
    audio_sample_rate?: number
    audio_size?: number
    bitrate?: number
    audio_format?: string
    audio_channel?: number
    word_count?: number
    usage_characters?: number
    invisible_character_ratio?: number
  }
  base_resp?: { status_code: number; status_msg?: string }
}

/**
 * 把 emotion 值映射到 MiniMax 接受的 8 个白名单值。
 *
 * 关键：MiniMax T2A v2 API 的 emotion 枚举**没有 'neutral'**：
 *   - 官方枚举：happy | sad | angry | fearful | disgusted | surprised | calm | fluent | whisper
 *   - 'calm' 是中性语义，但 ASR 系统（如火山）可能给 "neutral"
 *   - 如果传 'neutral' 给 API → 报 2013 invalid params → 我们代码会降级去掉 emotion → 用户感知"情绪参数失效"
 *
 * v0.4.12 修复：neutral → undefined（不传 emotion，让 MiniMax 自动匹配）
 *   - calm 是最接近"中性"的合法枚举，但语义不一样（calm 更"平静"）→ 不默认替换
 *   - 用户明确选 'calm' 才传，否则 emotion 字段不发送
 *
 * 输入可能来自 Volcano（surprise / fear / disgust）或用户自定义；
 * 不在白名单内的统一返回 undefined（不传 emotion 字段，避免 MiniMax 报 2013 invalid params）。
 */
const EMOTION_MAP: Record<string, string> = {
  // 直接对应
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  // Volcano → MiniMax
  surprise: 'surprised',
  surprised: 'surprised',
  fear: 'fearful',
  fearful: 'fearful',
  disgust: 'disgusted',
  disgusted: 'disgusted',
  // 同义词兜底
  excited: 'happy',
  joyful: 'happy',
  cheerful: 'happy',
  upset: 'sad',
  depressed: 'sad',
  furious: 'angry',
  mad: 'angry',
  calm: 'calm',         // MiniMax 合法枚举
  // ★ v0.4.12 关键修复：neutral 不在 MiniMax 枚举中 → 映射成 undefined（不发送 emotion 字段）
  // neutral: undefined    ← 注释掉，避免误删后面看到时困惑
  // flat: undefined
}

/** v0.4.12 标记：MiniMax 实际接受的 8 个 emotion 枚举值 */
const MINIMAX_VALID_EMOTIONS = new Set([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper',
])

const mapEmotionToMinimax = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined
  const key = raw.trim().toLowerCase()
  // v0.4.12 二次防御：即使映射表里有值，最终再校验一次是不是 MiniMax 真接受的枚举
  // 防止未来在 EMOTION_MAP 加新键忘了校验
  const mapped = EMOTION_MAP[key]
  if (!mapped) return undefined
  if (!MINIMAX_VALID_EMOTIONS.has(mapped)) return undefined
  return mapped
}

/** MiniMax emotion_intensity 取值范围 [0.5, 2.0] —— 越界就 clamp */
const clampIntensity = (v: number): number => {
  if (!Number.isFinite(v)) return 1.0
  return Math.max(0.5, Math.min(2.0, v))
}

const TTS_PRICE_TABLE: Record<string, number> = {
  'speech-2.8-hd': 2,
  'speech-2.8-turbo': 1,
  'speech-2.6-hd': 2,
  'speech-2.6-turbo': 1,
  'speech-02-hd': 2,
  'speech-02-turbo': 1,
}

const estimateTtsCost = (chars: number, model: string): number => {
  const price = TTS_PRICE_TABLE[model] ?? 2
  return Math.ceil((chars / 1000) * price)
}

// 没有 extra_info 时的兜底：每字符 80ms（中文均值）
const estimateDurationMs = (text: string): number => text.length * 80

const httpError = (status: number, body: string): AppError => {
  const code =
    status === 401 || status === 403
      ? ('provider.unauthorized' as const)
      : status === 429
        ? ('provider.rate-limited' as const)
        : status >= 500
          ? ('provider.upstream-5xx' as const)
          : ('provider.bad-request' as const)
  return new AppError({
    code,
    message: `MiniMax TTS HTTP ${status}: ${body.slice(0, 300)}`,
    retriable: code === 'provider.rate-limited' || code === 'provider.upstream-5xx',
    context: { status },
  })
}
