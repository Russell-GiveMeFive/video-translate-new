export * from './asr.js'
export * from './mock.js'
export * from './protocol.js'

/**
 * 火山豆包流式 ASR 鉴权配置（旧版控制台风格）：
 *   - appId / accessToken 一对（旧版 App-Key + Access-Key）
 *   - modelId：X-Api-Resource-Id 值；默认 'volc.seedasr.sauc.duration'
 *
 * 新版控制台只有一个 X-Api-Key —— 暂未实现，因为 v0.2 用户用旧版即可
 */
export interface VolcAsrConfig {
  appId: string
  accessToken: string
  /** X-Api-Resource-Id；默认 'volc.seedasr.sauc.duration' (Seed-ASR 2.0 小时版) */
  modelId?: string
  /** 完整 wss endpoint；默认 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream' */
  endpoint?: string
}
