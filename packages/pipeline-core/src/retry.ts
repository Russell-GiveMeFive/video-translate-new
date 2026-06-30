import { AppError, type NormalizedError, normalizeError } from '@dramaprime/core-types'

export interface RetryPolicy {
  retries: number
  baseMs: number
  capMs: number
  /** 是否对某错误重试 */
  shouldRetry?: (err: NormalizedError) => boolean
}

const DEFAULT_POLICY: RetryPolicy = {
  retries: 3,
  baseMs: 1_000,
  capMs: 30_000,
}

export const computeBackoff = (attempt: number, baseMs = 1_000, capMs = 30_000): number => {
  const expo = Math.min(capMs, baseMs * 2 ** attempt)
  const jitter = Math.random() * expo * 0.3
  return Math.floor(expo + jitter)
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new AppError({ code: 'pipeline.aborted', message: 'aborted', retriable: false }))
    })
  })

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  signal?: AbortSignal,
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_POLICY, ...policy }
  let lastErr: NormalizedError | undefined
  for (let attempt = 0; attempt <= p.retries; attempt++) {
    if (signal?.aborted)
      throw new AppError({ code: 'pipeline.aborted', message: 'aborted', retriable: false })
    try {
      return await fn()
    } catch (err) {
      const ne = normalizeError(err)
      lastErr = ne
      if (!ne.retriable && !p.shouldRetry?.(ne)) throw err
      if (attempt === p.retries) throw err
      const wait = ne.retryAfterMs ?? computeBackoff(attempt, p.baseMs, p.capMs)
      await sleep(wait, signal)
    }
  }
  // 不应到达
  throw new AppError(
    lastErr ?? { code: 'unknown', message: 'retry exhausted', retriable: false },
  )
}
