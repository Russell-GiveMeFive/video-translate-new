import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ApiBridge,
  ApiArg,
  ApiChannel,
  ApiResult,
  EventChannel,
  EventPayload,
  IpcResponse,
} from '@dramaprime/core-types'

// ─── invoke / on 实现 ────────────────────────────────────────────────
const invoke = <K extends ApiChannel>(
  channel: K,
  payload?: ApiArg<K>,
): Promise<IpcResponse<ApiResult<K>>> =>
  ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<ApiResult<K>>>

const on = <K extends EventChannel>(
  channel: K,
  listener: (payload: EventPayload<K>) => void,
): (() => void) => {
  const wrapped = (_evt: IpcRendererEvent, p: EventPayload<K>) => listener(p)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: ApiBridge = { invoke, on }

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: ApiBridge
  }
}
