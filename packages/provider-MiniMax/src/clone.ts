import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  CloneInput,
  VoiceCloneProvider,
  TtsProvider,
} from '@dramaprime/core-types'
import { AppError } from '@dramaprime/core-types'
import {
  buildAuthHeader,
  buildJsonHeaders,
  resolveBaseUrl,
  type MiniMaxConfig,
} from './config.js'

/**
 * MiniMax 音色复刻三步走（基于官方文档）：
 *
 *   1) 上传克隆音频：POST {baseUrl}/v1/files/upload
 *      multipart 字段：purpose=voice_clone, file=<binary>
 *      返回：{ file: { file_id: int64, ... }, base_resp: {...} }
 *      约束：mp3/m4a/wav，时长 10s-5min，≤20MB
 *
 *   2) 主接口：POST {baseUrl}/v1/voice_clone
 *      body：{ file_id, voice_id, model, need_noise_reduction, need_volume_normalization, ... }
 *      voice_id 命名规则：
 *        - 长度 [8, 256]
 *        - 首字符必须英文字母
 *        - 允许 字母/数字/-/_
 *        - 末位不可为 - 或 _
 *
 *   3) 临时音色：7 天内未通过 TTS 接口正式调用就会被删除
 *      "永久化"靠用 TTS 调用一次（即 promote()）
 */
export class MiniMaxVoiceCloneProvider implements VoiceCloneProvider {
  readonly name = 'MiniMax'
  /** 复刻临时音色有效期：168 小时 */
  static readonly TEMP_TTL_MS = 168 * 3600 * 1000

  constructor(
    private cfg: MiniMaxConfig,
    private ttsProvider: TtsProvider,
  ) {}

  async upload(
    samplePath: string,
    signal?: AbortSignal,
  ): Promise<{ fileId: string }> {
    const st = statSync(samplePath)
    if (st.size > 20 * 1024 * 1024) {
      throw new AppError({
        code: 'user.invalid-input',
        message: `音色样本超过 20MB（${(st.size / 1024 / 1024).toFixed(1)}MB）`,
        retriable: false,
      })
    }

    const url = `${resolveBaseUrl(this.cfg)}/v1/files/upload`
    const fd = new FormData()
    fd.append('purpose', 'voice_clone')
    const fileBuf = await readAll(createReadStream(samplePath))
    const ab = fileBuf.buffer.slice(
      fileBuf.byteOffset,
      fileBuf.byteOffset + fileBuf.byteLength,
    ) as ArrayBuffer
    fd.append('file', new Blob([ab]), basename(samplePath))

    const res = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeader(this.cfg), // multipart: 不能设 Content-Type，让 fetch 自动
      body: fd as any,
      signal,
    })
    if (!res.ok) {
      throw new AppError({
        code: res.status >= 500 ? 'provider.upstream-5xx' : 'provider.bad-request',
        message: `voice upload HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        retriable: res.status >= 500,
      })
    }
    const data = (await res.json()) as UploadResponse
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new AppError({
        code: 'provider.bad-request',
        message: `voice upload base_resp: ${data.base_resp.status_msg} (${data.base_resp.status_code})`,
        retriable: false,
      })
    }
    const fileId = data.file?.file_id
    if (fileId == null) {
      throw new AppError({
        code: 'provider.bad-request',
        message: 'voice upload 响应缺少 file.file_id',
        retriable: false,
      })
    }
    // file_id 是 int64，TS 用 string 承载更安全
    return { fileId: String(fileId) }
  }

  async clone(input: CloneInput): Promise<{ voiceId: string; expiresAt: number }> {
    const voiceId = input.suggestedVoiceId ?? generateVoiceId()
    validateVoiceId(voiceId)

    const body = {
      file_id: Number(input.fileId), // 文档要求 int64
      voice_id: voiceId,
      need_noise_reduction: true,
      need_volume_normalization: true,
      ...(input.model ? { model: input.model } : {}),
    }
    const url = `${resolveBaseUrl(this.cfg)}/v1/voice_clone`
    const res = await fetch(url, {
      method: 'POST',
      headers: buildJsonHeaders(this.cfg),
      body: JSON.stringify(body),
      signal: input.signal,
    })
    if (!res.ok) {
      throw new AppError({
        code: res.status >= 500 ? 'provider.upstream-5xx' : 'provider.bad-request',
        message: `voice clone HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
        retriable: res.status >= 500,
      })
    }
    const data = (await res.json()) as CloneResponse
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new AppError({
        code: 'provider.bad-request',
        message: `voice clone: ${data.base_resp.status_msg} (${data.base_resp.status_code})`,
        retriable: false,
      })
    }
    if (data.input_sensitive?.type && data.input_sensitive.type > 0) {
      throw new AppError({
        code: 'user.invalid-input',
        message: `音色样本未通过敏感检查 (type=${data.input_sensitive.type})`,
        retriable: false,
      })
    }
    return {
      voiceId,
      expiresAt: Date.now() + MiniMaxVoiceCloneProvider.TEMP_TTL_MS,
    }
  }

  async promote(voiceId: string): Promise<void> {
    // 用极短文本触发一次合成，把临时音色"用过一次"避免到期被清理
    await this.ttsProvider.synthesize({
      text: '你好。',
      voiceId,
      model: 'speech-2.8-hd',
    })
  }
}

// ─── 帮助函数 ─────────────────────────────────────────────────────────

const readAll = (stream: NodeJS.ReadableStream): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

/**
 * 生成符合 voice_id 命名规则的字符串：
 *   - 长度 [8, 256]
 *   - 首字符必须英文字母
 *   - 允许字母 / 数字 / - / _
 *   - 末位不可为 - 或 _
 */
const generateVoiceId = (): string => {
  // dp_ + 12 位随机字符（首字母 d 合规、末尾随机 alphanum 合规）
  const rand = Array.from({ length: 12 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)),
  ).join('')
  return `dp_${rand}`
}

const validateVoiceId = (id: string): void => {
  if (id.length < 8 || id.length > 256) {
    throw new AppError({
      code: 'user.invalid-input',
      message: `voice_id 长度需在 [8, 256] 之间，当前 ${id.length}`,
      retriable: false,
    })
  }
  if (!/^[A-Za-z]/.test(id)) {
    throw new AppError({
      code: 'user.invalid-input',
      message: 'voice_id 首字符必须为英文字母',
      retriable: false,
    })
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AppError({
      code: 'user.invalid-input',
      message: 'voice_id 只允许字母/数字/-/_',
      retriable: false,
    })
  }
  if (/[-_]$/.test(id)) {
    throw new AppError({
      code: 'user.invalid-input',
      message: 'voice_id 末位不可为 - 或 _',
      retriable: false,
    })
  }
}

interface UploadResponse {
  file?: {
    file_id?: number
    bytes?: number
    created_at?: number
    filename?: string
    purpose?: string
  }
  base_resp?: { status_code: number; status_msg?: string }
}

interface CloneResponse {
  input_sensitive?: { type: number }
  demo_audio?: string
  extra_info?: {
    audio_length?: number
    audio_sample_rate?: number
    audio_size?: number
    bitrate?: number
    word_count?: number
    usage_characters?: number
  }
  base_resp?: { status_code: number; status_msg?: string }
}
