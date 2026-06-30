import type { ApiArg, ApiChannel, ApiResult } from '@dramaprime/core-types'

/**
 * 薄包装：所有 invoke 都返回 IpcResponse，这里把 error 分支转成 throw，
 * 简化 React 端的 try/catch / SWR 用法。
 */
export const api = {
  async call<K extends ApiChannel>(
    channel: K,
    payload?: ApiArg<K>,
  ): Promise<ApiResult<K>> {
    const res = await window.api.invoke(channel, payload)
    if (!res.ok) {
      const err = new Error(res.error.message) as Error & { code?: string }
      err.code = res.error.code
      throw err
    }
    return res.data
  },
}
