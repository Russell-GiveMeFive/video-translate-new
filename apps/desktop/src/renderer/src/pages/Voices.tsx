import { useEffect, useState } from 'react'
import { api } from '../api/index.js'
import type { VoiceAsset } from '@dramaprime/core-types'

/**
 * v0.4.12 音色库 —— 跨项目收集的复刻音色
 *
 * 数据来源：每次 voice-clone 成功时，voice-clone-stage 调 VoiceAssetRepo.record()
 * 这里只读 + 重命名 + 删除（不动其他项目对该 voice_id 的引用）
 */
export function Voices(): JSX.Element {
  const [voices, setVoices] = useState<VoiceAsset[]>([])
  const [loading, setLoading] = useState(true)
  // 重命名 inline 编辑状态
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  // 删除确认
  const [confirmDelete, setConfirmDelete] = useState<VoiceAsset | null>(null)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await api.call('voice:list')
      setVoices(list)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-8 py-5">
        <div>
          <h1 className="text-xl font-semibold">音色库</h1>
          <div className="mt-1 text-xs text-zinc-500">
            跨项目收集的所有复刻音色。删除只是从库移除、不影响其他项目对该 voice_id 的引用。
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </header>
      <div className="flex-1 overflow-auto px-8 py-6">
        {loading && voices.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">加载中…</div>
        ) : voices.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-500">
            <div>还没有复刻过的音色</div>
            <div className="text-xs">去项目里跑完 voice-clone stage 后这里会自动出现</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {voices.map((v) => (
              <div
                key={v.id}
                className="group flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-indigo-500/40 hover:bg-zinc-900/70"
              >
                {/* 顶部：名称（可重命名）+ 状态 */}
                <div className="flex items-center justify-between">
                  {editing?.id === v.id ? (
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      onBlur={async () => {
                        if (editing.name && editing.name !== v.name) {
                          await api.call('voice:rename', {
                            voiceId: v.voiceId,
                            name: editing.name,
                          })
                        }
                        setEditing(null)
                        await load()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                      autoFocus
                      className="flex-1 rounded border border-indigo-500 bg-zinc-950 px-2 py-1 text-sm outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => setEditing({ id: v.id, name: v.name })}
                      className="truncate text-base font-medium hover:underline"
                      title="点击重命名"
                    >
                      {v.name}
                    </button>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
                      v.status === 'temp'
                        ? 'bg-amber-500/20 text-amber-300'
                        : 'bg-emerald-500/20 text-emerald-300'
                    }`}
                  >
                    {v.status}
                  </span>
                </div>
                {/* voice_id */}
                <div className="font-mono text-[10px] text-zinc-500">
                  {v.voiceId}
                </div>
                {/* 来源 tags */}
                {v.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {v.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {/* 创建时间 + 删除 */}
                <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
                  <span>{new Date(v.createdAt).toLocaleString('zh-CN')}</span>
                  <button
                    onClick={() => setConfirmDelete(v)}
                    className="hidden rounded p-1 text-zinc-500 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block"
                    title="从音色库移除（不影响其他项目）"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[420px] rounded-lg border border-rose-700/40 bg-zinc-900 p-6">
            <h2 className="mb-3 text-base font-semibold text-rose-300">从音色库移除？</h2>
            <div className="mb-4 text-sm text-zinc-300">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-rose-200">
                {confirmDelete.name}
              </span>
              <div className="mt-2 text-xs text-zinc-500">
                仅从音色库移除记录。
                <strong className="text-amber-300">不会删除</strong>MiniMax 服务端 voice_id，
                也不影响其他项目对该 voice_id 的引用。
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  await api.call('voice:delete', { voiceId: confirmDelete.voiceId })
                  setConfirmDelete(null)
                  await load()
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs hover:bg-rose-500"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}