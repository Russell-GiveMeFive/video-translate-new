import type { ChatInput, ChatMessage, ChatOutput, ContentBlockText, LlmProvider } from '@dramaprime/core-types'
import { AppError } from '@dramaprime/core-types'
import {
  buildJsonHeaders,
  MINIMAX_DEFAULT_TIMEOUT_MS,
  resolveBaseUrl,
  type MiniMaxConfig,
} from './config.js'

/**
 * MiniMax-M3 LLM provider，走 Anthropic 兼容路径：
 *   POST {baseUrl}/anthropic/v1/messages
 *
 * 选择 Anthropic 兼容版（而非 OpenAI 兼容）的原因：
 *   1. M3 官方推荐路径，schema 与 MiniMax 模型能力对齐最好
 *   2. 支持 thinking 控制（短剧翻译不需要 thinking，会显式 disable 提速 + 省 token）
 *   3. response 中 message.content 是块列表（thinking/text/tool_use），结构清晰
 */
export class MiniMaxLlmProvider implements LlmProvider {
  readonly name = 'MiniMax'

  constructor(private cfg: MiniMaxConfig) {}

  async chat(input: ChatInput): Promise<ChatOutput> {
    const { system, messages } = splitSystemMessage(input.messages)

    const body: Record<string, unknown> = {
      model: input.model ?? 'MiniMax-M3',
      messages,
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0.6,
      stream: false,
      // 翻译任务关闭 thinking：节省延迟和 token
      thinking: { type: 'disabled' },
    }
    if (system) body.system = system

    const url = `${resolveBaseUrl(this.cfg)}/anthropic/v1/messages`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? MINIMAX_DEFAULT_TIMEOUT_MS,
    )
    input.signal?.addEventListener('abort', () => controller.abort())

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: buildJsonHeaders(this.cfg),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw mapHttpError(res.status, await res.text())
      }
      const data = (await res.json()) as AnthropicResponse
      const text = extractText(data)
      const usage = data.usage ?? { input_tokens: 0, output_tokens: 0 }
      return {
        text,
        usage: {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
        },
        costCents: estimateLlmCost(
          body.model as string,
          usage.input_tokens,
          usage.output_tokens,
        ),
        requestId: data.id,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  estimateCost(input: ChatInput): number {
    const chars = input.messages.reduce((n, m) => n + contentLength(m.content), 0)
    return Math.max(1, Math.floor(chars / 1000))
  }
}

/** 算 ChatMessage.content 的字符数（string 或 block[]） */
const contentLength = (c: ChatMessage['content']): number => {
  if (typeof c === 'string') return c.length
  return c.reduce((n, b) => n + (b.type === 'text' ? b.text.length : 0), 0)
}

// ─── Anthropic response 类型 ──────────────────────────────────────────
interface AnthropicTextBlock {
  type: 'text'
  text: string
}
interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
}
interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock

interface AnthropicResponse {
  id?: string
  model?: string
  role?: 'assistant'
  type?: 'message'
  stop_reason?: string
  stop_sequence?: string
  content?: AnthropicContentBlock[]
  usage?: { input_tokens: number; output_tokens: number }
}

/**
 * Anthropic 把 system 拆出 messages 数组，单独成顶层字段。
 * 我们的 ChatInput 沿用 OpenAI 风格（system 作为 message[0]），这里转一下。
 * system 必须扁平化成 string（Anthropic top-level system 只接受 string）。
 */
const splitSystemMessage = (
  messages: ChatMessage[],
): { system: string | undefined; messages: ChatMessage[] } => {
  if (messages[0]?.role === 'system') {
    const c = messages[0].content
    const sys = typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => (b as ContentBlockText).text).join('\n')
    return { system: sys, messages: messages.slice(1) }
  }
  return { system: undefined, messages }
}

const extractText = (data: AnthropicResponse): string => {
  if (!data.content) return ''
  return data.content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// ─── 价格表（cents per 1k tokens；占位，以官方为准） ──────────────────
const LLM_PRICE_TABLE: Record<string, { in: number; out: number }> = {
  'MiniMax-M3': { in: 0.1, out: 0.3 },
  'MiniMax-M2.7': { in: 0.08, out: 0.24 },
  'MiniMax-M2.7-highspeed': { in: 0.06, out: 0.18 },
}

const estimateLlmCost = (model: string, promptTokens: number, completionTokens: number): number => {
  const p = LLM_PRICE_TABLE[model] ?? { in: 0.1, out: 0.3 }
  const cents = (promptTokens * p.in + completionTokens * p.out) / 1000
  return Math.ceil(cents * 100)
}

const mapHttpError = (status: number, body: string): AppError => {
  const code =
    status === 401 || status === 403
      ? ('provider.unauthorized' as const)
      : status === 429
        ? ('provider.rate-limited' as const)
        : status === 402
          ? ('provider.payment-required' as const)
          : status >= 500
            ? ('provider.upstream-5xx' as const)
            : ('provider.bad-request' as const)
  return new AppError({
    code,
    message: `MiniMax LLM HTTP ${status}: ${body.slice(0, 300)}`,
    retriable: code === 'provider.rate-limited' || code === 'provider.upstream-5xx',
    context: { status },
  })
}
