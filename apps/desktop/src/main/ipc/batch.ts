import { handle, type IpcContext } from './index.js'
import { asBatchId } from '@dramaprime/core-types'

export const registerBatchIpc = (_ctx: IpcContext): void => {
  handle('batch:enqueue', async (_input) => ({ batchId: asBatchId('stub-batch') }))
  handle('batch:status', async (_input) => [])
  handle('batch:cancel', async (_input) => {
    throw new Error('batch:cancel 待实现（v0.1 stub）')
  })
}
