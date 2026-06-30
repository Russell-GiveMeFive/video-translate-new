export type ErrorCode =
  // provider 类
  | 'provider.unauthorized'
  | 'provider.rate-limited'
  | 'provider.payment-required'
  | 'provider.timeout'
  | 'provider.bad-request'
  | 'provider.upstream-5xx'
  | 'provider.network'
  // sidecar 类
  | 'sidecar.crashed'
  | 'sidecar.method-not-found'
  | 'sidecar.model-missing'
  // ffmpeg 类
  | 'ffmpeg.encode-failed'
  | 'ffmpeg.input-corrupted'
  | 'ffmpeg.not-found'
  // 业务类
  | 'pipeline.upstream-missing'
  | 'pipeline.validation-failed'
  | 'pipeline.aborted'
  // 用户输入
  | 'user.invalid-input'
  | 'user.file-not-found'
  // 通用
  | 'unknown'

export interface NormalizedError {
  code: ErrorCode
  message: string
  cause?: string
  retriable: boolean
  retryAfterMs?: number
  context?: Record<string, unknown>
}

export class AppError extends Error implements NormalizedError {
  code: ErrorCode
  retriable: boolean
  retryAfterMs?: number
  // Error 自带 cause: unknown，这里我们存字符串
  override cause?: string
  context?: Record<string, unknown>

  constructor(input: NormalizedError) {
    super(input.message)
    this.name = 'AppError'
    this.code = input.code
    this.retriable = input.retriable
    this.retryAfterMs = input.retryAfterMs
    this.cause = input.cause
    this.context = input.context
  }
}

export const isAppError = (e: unknown): e is AppError =>
  e instanceof AppError || (typeof e === 'object' && e !== null && 'code' in e && 'retriable' in e)

export const normalizeError = (e: unknown): NormalizedError => {
  if (isAppError(e)) {
    return {
      code: e.code,
      message: e.message,
      retriable: e.retriable,
      retryAfterMs: e.retryAfterMs,
      cause: e.cause,
      context: e.context,
    }
  }
  if (e instanceof Error) {
    return { code: 'unknown', message: e.message, retriable: false, cause: e.stack }
  }
  return { code: 'unknown', message: String(e), retriable: false }
}
