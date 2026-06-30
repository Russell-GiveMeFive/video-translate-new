/**
 * MiniMax 国内站点 base URL。
 *
 * 文档来源：https://platform.minimaxi.com/docs/api-reference/
 *  - LLM Chat（M3，Anthropic 兼容）：`{baseUrl}/anthropic/v1/messages`
 *  - LLM Chat（OpenAI 兼容）：`{baseUrl}/v1/chat/completions`
 *  - TTS T2A v2：`{baseUrl}/v1/t2a_v2`
 *  - 文件上传：`{baseUrl}/v1/files/upload`
 *  - 音色复刻：`{baseUrl}/v1/voice_clone`
 *
 * 国内有两个 base 主站，均可（北京备用）：
 *  - https://api.minimaxi.com
 *  - https://api-bj.minimaxi.com
 */
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.com'
export const MINIMAX_BJ_BASE_URL = 'https://api-bj.minimaxi.com'
export const MINIMAX_DEFAULT_TIMEOUT_MS = 60_000

export interface MiniMaxConfig {
  apiKey: string
  groupId?: string
  baseUrl?: string
  timeoutMs?: number
}

export const buildJsonHeaders = (cfg: MiniMaxConfig): Record<string, string> => ({
  Authorization: `Bearer ${cfg.apiKey}`,
  'Content-Type': 'application/json',
})

export const buildAuthHeader = (cfg: MiniMaxConfig): Record<string, string> => ({
  Authorization: `Bearer ${cfg.apiKey}`,
})

export const resolveBaseUrl = (cfg: MiniMaxConfig): string =>
  cfg.baseUrl ?? MINIMAX_DEFAULT_BASE_URL

// 兼容旧调用（v0.1 写过 buildHeaders）
export const buildHeaders = buildJsonHeaders
