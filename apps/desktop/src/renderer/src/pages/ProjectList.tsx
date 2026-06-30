import { useEffect, useState } from 'react'
import { api } from '../api/index.js'
import { useAppStore } from '../stores/app.js'
import {
  LANGUAGES_BY_TIER,
  LANG_MAP,
  type CreateProjectInput,
  type ProjectConfig,
} from '@dramaprime/core-types'

interface Props {
  onOpen: () => void
}

const DEFAULT_CONFIG: ProjectConfig = {
  targetLang: 'en',
  renderPreset: 'reelshort-9x16-1080p',
  align: { toleranceMs: 100, enableVideoSlow: true, videoSlowMaxRatio: 0.05 },
  translation: { style: 'dubbing', glossaryEnabled: true },
  tts: { model: 'speech-2.8-hd' },
  llm: { model: 'MiniMax-M3' },
  subtitle: { burnIn: true, bilingual: true },
  // v0.4.9 默认 true：短剧绝大多数有烧录中文字幕。
  // 用户创建项目向导里可改为 false 跳过 VLM OCR，省 ~$1/单片成本。
  ocr: { hasBurnedInSubtitles: true },
}

const TIER_LABEL = {
  P0: 'P0 主力（人工校准） · 5 种',
  P1: 'P1 重点 · 15 种',
  P2: 'P2 覆盖 · 20 种',
} as const

export function ProjectList({ onOpen }: Props): JSX.Element {
  const projects = useAppStore((s) => s.projects)
  const setProjects = useAppStore((s) => s.setProjects)
  const setCurrent = useAppStore((s) => s.setCurrentProjectId)
  const [showNew, setShowNew] = useState(false)
  const [refreshFlag, setRefreshFlag] = useState(0)
  // v0.4.12 搜索词（按项目名过滤）
  const [search, setSearch] = useState('')
  // v0.4.12 删除确认 dialog
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    void api.call('project:list').then(setProjects)
  }, [setProjects, refreshFlag])

  // 搜索过滤（不区分大小写，匹配项目名 + 目标语言）
  const filtered = projects.filter((p) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      p.name.toLowerCase().includes(q) ||
      p.targetLang.toLowerCase().includes(q) ||
      (LANG_MAP[p.targetLang]?.zhName ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-8 py-5">
        <h1 className="text-xl font-semibold">项目</h1>
        <div className="flex gap-2">
          {/* v0.4.12 搜索框 */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索项目名 / 目标语言"
            className="w-56 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            onClick={() => setShowNew(true)}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium hover:bg-indigo-400"
          >
            + 新建项目
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-auto px-8 py-6">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            还没有项目，点右上角「新建项目」开始第一次译制吧
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            没有匹配「{search}」的项目
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((p) => (
              <div
                key={p.id}
                className="group relative flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-indigo-500/40 hover:bg-zinc-900/70"
              >
                <button
                  onClick={() => {
                    setCurrent(p.id)
                    onOpen()
                  }}
                  className="text-left"
                >
                  <div className="flex items-center justify-between pr-6">
                    <span className="truncate text-base font-medium">{p.name}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">
                    目标：{LANG_MAP[p.targetLang]?.zhName ?? p.targetLang}
                  </div>
                  <div className="text-xs text-zinc-500">
                    累计成本：¥ {(p.costTotalCents / 100).toFixed(2)}
                  </div>
                </button>
                {/* v0.4.12 删除按钮（hover 才显示） */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDelete({ id: p.id, name: p.name })
                  }}
                  className="absolute right-2 top-2 hidden rounded p-1 text-zinc-500 hover:bg-rose-500/20 hover:text-rose-300 group-hover:block"
                  title="删除项目"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {showNew && (
        <NewProjectDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            setRefreshFlag((n) => n + 1)
          }}
        />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[420px] rounded-lg border border-rose-700/40 bg-zinc-900 p-6">
            <h2 className="mb-3 text-base font-semibold text-rose-300">删除项目？</h2>
            <div className="mb-4 text-sm text-zinc-300">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-rose-200">
                {confirmDelete.name}
              </span>
              <div className="mt-2 text-xs text-zinc-500">
                将从数据库删除项目记录、清空该项目的所有工作目录（源视频文件不变）。
                <br />
                <strong className="text-amber-300">该操作不可撤销。</strong>
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
                  await api.call('project:delete', confirmDelete.id as any)
                  setConfirmDelete(null)
                  setRefreshFlag((n) => n + 1)
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs hover:bg-rose-500"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, string> = {
    created: 'bg-zinc-700 text-zinc-300',
    running: 'bg-indigo-500/20 text-indigo-300',
    paused: 'bg-amber-500/20 text-amber-300',
    done: 'bg-emerald-500/20 text-emerald-300',
    failed: 'bg-rose-500/20 text-rose-300',
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${map[status] ?? ''}`}>
      {status}
    </span>
  )
}

function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [targetLang, setTargetLang] = useState<string>('en')
  const [hasBurnedInSubtitles, setHasBurnedInSubtitles] = useState<boolean>(true)
  const [busy, setBusy] = useState(false)

  const pickFile = async (): Promise<void> => {
    const paths = await api.call('system:select-file', { kind: 'video' })
    if (paths.length > 0) {
      setSourcePath(paths[0]!)
      if (!name) {
        const base = paths[0]!.split(/[\\/]/).pop() ?? ''
        setName(base.replace(/\.[^.]+$/, ''))
      }
    }
  }

  const submit = async (): Promise<void> => {
    if (!name || !sourcePath) return
    setBusy(true)
    try {
      const input: CreateProjectInput = {
        name,
        sourcePath,
        config: {
          ...DEFAULT_CONFIG,
          targetLang,
          ocr: { hasBurnedInSubtitles },
        },
      }
      await api.call('project:create', input)
      onCreated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="mb-5 text-lg font-semibold">新建译制项目</h2>
        <label className="mb-1 block text-xs text-zinc-400">项目名</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          placeholder="例如：EP01_她是我的小娇妻"
        />
        <label className="mb-1 block text-xs text-zinc-400">源视频</label>
        <div className="mb-4 flex gap-2">
          <input
            value={sourcePath}
            readOnly
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs outline-none"
            placeholder="选择 mp4 / mov / mkv …"
          />
          <button
            onClick={pickFile}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
          >
            选择
          </button>
        </div>
        <label className="mb-1 block text-xs text-zinc-400">
          目标语言
          <span className="ml-2 text-zinc-600">·  全 40 种（按校准等级分组）</span>
        </label>
        <select
          value={targetLang}
          onChange={(e) => setTargetLang(e.target.value)}
          className="mb-2 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
        >
          {(['P0', 'P1', 'P2'] as const).map((tier) => (
            <optgroup key={tier} label={TIER_LABEL[tier]}>
              {LANGUAGES_BY_TIER[tier].map((l) => (
                <option key={l.code} value={l.code}>
                  {l.zhName}（{l.code}）
                  {l.rtl ? ' · RTL' : ''}
                  {l.needsFont ? ' · 需字体' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/* 当前所选语种的提示 */}
        {(() => {
          const lang = LANG_MAP[targetLang]
          if (!lang) return null
          const hints: string[] = []
          if (lang.tier === 'P0') hints.push('P0 主力语种：人工校准、质量最高')
          if (lang.rtl) hints.push('RTL：从右到左书写')
          if (lang.needsFont) hints.push(`需 ${lang.needsFont} 字体`)
          if (lang.regionNeutralRule) hints.push(`地区中性化：${lang.regionNeutralRule}`)
          return hints.length > 0 ? (
            <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
              {hints.map((h, i) => (
                <div key={i}>· {h}</div>
              ))}
            </div>
          ) : (
            <div className="mb-4" />
          )
        })()}
        {/* v0.4.9 原片是否有烧录中文字幕（控制 VLM OCR 跑不跑） */}
        <label className="mb-1 block text-xs text-zinc-400">
          原片是否有烧录中文字幕？
          <span className="ml-2 text-zinc-600">· 有字幕开 OCR 让译文 1:1 对齐原片节奏</span>
        </label>
        <div className="mb-6 flex gap-3">
          <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm hover:border-zinc-600">
            <input
              type="radio"
              name="hasBurnedInSubtitles"
              checked={hasBurnedInSubtitles}
              onChange={() => setHasBurnedInSubtitles(true)}
            />
            <span>有字幕（推荐）</span>
            <span className="ml-auto text-[10px] text-zinc-500">~+1 分钟、~$0.5-1.5</span>
          </label>
          <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm hover:border-zinc-600">
            <input
              type="radio"
              name="hasBurnedInSubtitles"
              checked={!hasBurnedInSubtitles}
              onChange={() => setHasBurnedInSubtitles(false)}
            />
            <span>无字幕</span>
            <span className="ml-auto text-[10px] text-zinc-500">省时省钱</span>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            disabled={busy || !name || !sourcePath}
            onClick={submit}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-zinc-700"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
