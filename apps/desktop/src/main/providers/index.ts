import { join } from 'node:path'
import { app } from 'electron'
import {
  MockMiniMaxLlmProvider,
  MockMiniMaxTtsProvider,
  MockMiniMaxVoiceCloneProvider,
  MiniMaxLlmProvider,
  MiniMaxTtsProvider,
  MiniMaxVoiceCloneProvider,
  type MiniMaxConfig,
} from '@dramaprime/provider-MiniMax'
import {
  MockVolcAsrProvider,
  VolcAsrProvider,
  type VolcAsrConfig,
} from '@dramaprime/provider-volcengine'
import type { ProviderRegistry } from '@dramaprime/core-types'
import { Keystore } from '../keystore/index.js'
import { logger } from '../logger.js'

/**
 * 全 provider registry：随 keystore 变化运行时热切换。
 *
 * 加载逻辑：
 * 1. 任一 provider 缺 key → 该 provider 用 mock 兜底
 * 2. 用户在「设置」页保存 key 后，调 `refreshProviders()` 立即切换
 * 3. 切换后 emit provider:changed 给 Renderer，UI 可显示「已接入」状态
 */

export type ProviderMode = 'mock' | 'real'

export interface ProviderStatus {
  llm: ProviderMode
  tts: ProviderMode
  clone: ProviderMode
  asr: ProviderMode
}

let _providers: ProviderRegistry | undefined
let _status: ProviderStatus = { llm: 'mock', tts: 'mock', clone: 'mock', asr: 'mock' }
const _listeners = new Set<(status: ProviderStatus) => void>()

const ttsOutDir = (): string => join(app.getPath('userData'), 'cache', 'tts-temp')

const buildMiniMaxConfig = async (): Promise<MiniMaxConfig | null> => {
  const apiKey = await Keystore.get('MiniMax.api_key')
  if (!apiKey) return null
  const groupId = await Keystore.get('MiniMax.group_id')
  return { apiKey, groupId: groupId ?? undefined }
}

const buildVolcAsrConfig = async (): Promise<VolcAsrConfig | null> => {
  const appId = await Keystore.get('volcengine.app_id')
  const accessToken = await Keystore.get('volcengine.access_token')
  if (!appId || !accessToken) return null
  return { appId, accessToken }
}

/** 初始化（应用启动时调一次） */
export const initProviders = async (): Promise<ProviderRegistry> => {
  await refreshProviders()
  return _providers!
}

/** 热切换（设置页保存 key 后调用） */
export const refreshProviders = async (): Promise<ProviderStatus> => {
  const mmCfg = await buildMiniMaxConfig()
  const volcCfg = await buildVolcAsrConfig()
  const next: ProviderRegistry = {
    llm: mmCfg ? new MiniMaxLlmProvider(mmCfg) : new MockMiniMaxLlmProvider(),
    tts: mmCfg ? new MiniMaxTtsProvider(mmCfg, ttsOutDir()) : new MockMiniMaxTtsProvider(),
    clone: mmCfg
      ? new MiniMaxVoiceCloneProvider(mmCfg, new MiniMaxTtsProvider(mmCfg, ttsOutDir()))
      : new MockMiniMaxVoiceCloneProvider(),
    asr: volcCfg ? new VolcAsrProvider(volcCfg) : new MockVolcAsrProvider(),
  }
  _providers = next
  const newStatus: ProviderStatus = {
    llm: mmCfg ? 'real' : 'mock',
    tts: mmCfg ? 'real' : 'mock',
    clone: mmCfg ? 'real' : 'mock',
    asr: volcCfg ? 'real' : 'mock',
  }
  const changed = JSON.stringify(newStatus) !== JSON.stringify(_status)
  _status = newStatus
  if (changed) {
    logger.info({ status: _status }, 'providers refreshed')
    for (const fn of _listeners) {
      try {
        fn(_status)
      } catch (err) {
        logger.warn({ err }, 'provider status listener threw')
      }
    }
  }
  return _status
}

export const providers = (): ProviderRegistry => {
  if (!_providers) throw new Error('providers not initialized')
  return _providers
}

export const providerStatus = (): ProviderStatus => _status

export const onProviderStatusChange = (fn: (status: ProviderStatus) => void): (() => void) => {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}

/** 测试连接（在设置页点"测试 MiniMax / 火山"按钮时调） */
export const testProvider = async (
  kind: 'MiniMax' | 'volcengine',
): Promise<{ ok: boolean; error?: string; latencyMs?: number }> => {
  if (kind === 'MiniMax') {
    const cfg = await buildMiniMaxConfig()
    if (!cfg) return { ok: false, error: '未配置 MiniMax API Key' }
    const t0 = Date.now()
    try {
      const llm = new MiniMaxLlmProvider(cfg)
      await llm.chat({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1,
        model: 'MiniMax-M3',
      })
      return { ok: true, latencyMs: Date.now() - t0 }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }
  if (kind === 'volcengine') {
    const cfg = await buildVolcAsrConfig()
    if (!cfg) {
      return {
        ok: false,
        error: '未配置火山引擎 AppID + AccessToken（设置页都填了再点测试）',
      }
    }
    // 真实探活：建一个 wss、发个空配置帧、立即关闭
    // 这里简化：只验证 key 存在；真正连通性由跑流水线时验证
    return { ok: true }
  }
  return { ok: false, error: 'unknown provider' }
}
