import { useEffect, useState } from 'react'
import { api } from '../api/index.js'
import type { KeyName } from '@dramaprime/core-types'

interface KeyField {
  key: KeyName
  label: string
  hint: string
}

const KEY_FIELDS: KeyField[] = [
  { key: 'MiniMax.api_key', label: 'MiniMax API Key', hint: '从 platform.minimaxi.com 获取' },
  { key: 'MiniMax.group_id', label: 'MiniMax Group ID', hint: '选填' },
  { key: 'volcengine.app_id', label: '火山引擎 AppID', hint: 'console.volcengine.com' },
  { key: 'volcengine.access_token', label: '火山引擎 Access Token', hint: 'ASR 服务凭证' },
  { key: 'volcengine.cluster', label: '火山引擎 Cluster', hint: 'ASR 集群 ID' },
]

export function Settings(): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg?: string }>>({})

  useEffect(() => {
    const load = async (): Promise<void> => {
      const next: Record<string, string> = {}
      for (const f of KEY_FIELDS) {
        const v = await api.call('keystore:get', f.key).catch(() => null)
        if (v) next[f.key] = v
      }
      setValues(next)
    }
    void load()
  }, [])

  const save = async (key: KeyName, value: string): Promise<void> => {
    setSavingKey(key)
    try {
      await api.call('keystore:set', { key, value })
    } finally {
      setSavingKey(null)
    }
  }

  const test = async (provider: 'MiniMax' | 'volcengine'): Promise<void> => {
    const r = await api.call('keystore:test', provider)
    setTestResult((m) => ({ ...m, [provider]: { ok: r.ok, msg: r.error } }))
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <h1 className="mb-6 text-xl font-semibold">设置</h1>

      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
        <h2 className="mb-4 text-sm font-semibold">API 密钥</h2>
        <div className="space-y-4">
          {KEY_FIELDS.map((f) => (
            <div key={f.key} className="grid grid-cols-[180px_1fr_auto] items-center gap-3">
              <label className="text-xs text-zinc-400">
                {f.label}
                <div className="text-[10px] text-zinc-500">{f.hint}</div>
              </label>
              <input
                type="password"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => save(f.key, values[f.key] ?? '')}
                disabled={savingKey === f.key}
                className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:bg-zinc-800"
              >
                {savingKey === f.key ? '保存中…' : '保存'}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button
            onClick={() => test('MiniMax')}
            className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:bg-zinc-800"
          >
            测试 MiniMax
          </button>
          <button
            onClick={() => test('volcengine')}
            className="rounded-md border border-zinc-700 px-3 py-2 text-xs hover:bg-zinc-800"
          >
            测试火山引擎
          </button>
          {Object.entries(testResult).map(([k, v]) => (
            <span key={k} className={`text-xs ${v.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {k}: {v.ok ? 'OK' : v.msg ?? 'failed'}
            </span>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-xs text-zinc-500">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">关于</h2>
        <p>DramaPrime v0.1 · 短剧 AI 译制桌面工作站</p>
        <p>本地数据：App Data 目录；API 密钥：系统 Keychain / DPAPI 加密存储</p>
        <button
          onClick={() => api.call('system:reveal-logs')}
          className="mt-3 rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
        >
          打开日志目录
        </button>
      </section>
    </div>
  )
}
