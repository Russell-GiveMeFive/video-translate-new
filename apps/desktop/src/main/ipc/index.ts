import { ipcMain, type BrowserWindow } from 'electron'
import {
  type ApiArg,
  type ApiChannel,
  type ApiResult,
  type IpcResponse,
  normalizeError,
} from '@dramaprime/core-types'
import { logger } from '../logger.js'
import { registerSystemIpc } from './system.js'
import { registerKeystoreIpc } from './keystore.js'
import { registerProjectIpc } from './project.js'
import { registerPipelineIpc } from './pipeline.js'
import { registerSegmentIpc } from './segment.js'
import { registerCharacterIpc } from './character.js'
import { registerVoiceIpc } from './voice.js'
import { registerBatchIpc } from './batch.js'

export interface IpcContext {
  getMainWindow: () => BrowserWindow | null
}

/** 统一包装：所有 invoke 都返回 IpcResponse<T> */
export const handle = <K extends ApiChannel>(
  channel: K,
  handler: (payload: ApiArg<K>) => Promise<ApiResult<K>>,
): void => {
  ipcMain.handle(channel, async (_evt, payload: ApiArg<K>): Promise<IpcResponse<ApiResult<K>>> => {
    const t0 = Date.now()
    try {
      const data = await handler(payload)
      logger.debug({ channel, ms: Date.now() - t0 }, 'ipc.ok')
      return { ok: true, data }
    } catch (err) {
      const e = normalizeError(err)
      logger.warn({ channel, code: e.code, ms: Date.now() - t0, msg: e.message }, 'ipc.err')
      return { ok: false, error: e }
    }
  })
}

export const registerAllIpc = (ctx: IpcContext): void => {
  registerSystemIpc(ctx)
  registerKeystoreIpc(ctx)
  registerProjectIpc(ctx)
  registerPipelineIpc(ctx)
  registerSegmentIpc(ctx)
  registerCharacterIpc(ctx)
  registerVoiceIpc(ctx)
  registerBatchIpc(ctx)
}
