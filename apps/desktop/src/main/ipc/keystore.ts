import { handle, type IpcContext } from './index.js'
import { Keystore } from '../keystore/index.js'
import { refreshProviders, testProvider } from '../providers/index.js'

export const registerKeystoreIpc = (_ctx: IpcContext): void => {
  handle('keystore:get', async (key) => Keystore.get(key))

  handle('keystore:set', async ({ key, value }) => {
    await Keystore.set(key, value)
    // key 变化 → 立刻热切换 provider，无需重启
    await refreshProviders()
  })

  handle('keystore:test', async (provider) => testProvider(provider))
}
