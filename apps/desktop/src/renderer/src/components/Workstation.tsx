import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/index.js'
import type {
  Character,
  ProjectId,
  Segment,
  SegmentAssets,
  SegmentId,
} from '@dramaprime/core-types'

interface Props {
  projectId: ProjectId
  /** 用作刷新触发器：父组件在 align 阶段完成后递增此值 */
  refreshKey?: number
  /** 角色按钮（"使用原音"等）完成后，刷新 character 列表 */
  onCharactersChanged?: () => void
  /** 重合成单句后回调（Workstation 父层传） */
  onResynthDone?: () => void
}

/**
 * 工作台（Workstation）面板——把流水线产物全部可视化：
 *
 *   ┌─ 角色区（character grid）── 头像 / 姓名 / 性别 / 克隆状态
 *   ├─ Segment 表 ── 缩略图 / 原音播放 / 克隆样本 / TTS 播放 / 角色 / emotion / 译文
 *   └─ 详情区（选中 segment 后展开）── 大图 + 3 音频对比 + 可编辑表单 + 重合成按钮
 *
 * 设计要点：
 *   - 资产懒加载：选中 segment 才调 segment:assets 拿路径
 *   - 音频用 system:read-file-as-data-url 转 dataUrl 喂给 <audio>
 *   - 重合成走 segment:resynth，完成后局部刷新这一行
 */
export function Workstation({ projectId, refreshKey, onResynthDone, onCharactersChanged }: Props): JSX.Element {
  const [segments, setSegments] = useState<Segment[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [selectedSegId, setSelectedSegId] = useState<SegmentId | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.call('segment:list', { projectId }),
      api.call('character:list', { projectId }),
    ])
      .then(([segs, chars]) => {
        setSegments(segs)
        setCharacters(chars)
      })
      .finally(() => setLoading(false))
  }, [projectId, refreshKey])

  const characterById = useMemo(
    () => new Map(characters.map((c) => [c.id, c])),
    [characters],
  )

  if (loading) {
    return <div className="p-6 text-sm text-zinc-500">加载工作台数据…</div>
  }
  if (segments.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-500">
        还没有 segment 数据——跑到 cluster 阶段后再来看。
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col gap-3 overflow-hidden p-6">
      {/* === 上：角色区 === */}
      <CharacterGrid
        characters={characters}
        segments={segments}
        onResynthDone={() => {
          onResynthDone?.()
          // v0.4.16 P1/P2 按钮：拉取最新的 character useOriginalAudio 标志
          onCharactersChanged?.()
        }}
        projectId={projectId}
      />

      {/* === 中：segment 表（详情展开时不挤压） === */}
      <div className="flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
        <SegmentTable
          segments={segments}
          characterById={characterById}
          selectedId={selectedSegId}
          onSelect={setSelectedSegId}
        />
      </div>

      {/* === 详情区：浮层（v0.4.11 不挤压表格） === */}
      {selectedSegId && (
        <SegmentDetail
          projectId={projectId}
          segmentId={selectedSegId}
          segment={segments.find((s) => s.id === selectedSegId) ?? null}
          characters={characters}
          onClose={() => setSelectedSegId(null)}
          onResynthDone={() => {
            void api.call('segment:list', { projectId }).then(setSegments)
          }}
        />
      )}
    </div>
  )
}

// ─── 角色区 ──────────────────────────────────────────────────────────

function CharacterGrid({
  characters,
  segments,
  onResynthDone,
  projectId,
}: {
  characters: Character[]
  segments: Segment[]
  onResynthDone: () => void
  projectId: string
}): JSX.Element {
  // 算每个角色的 segment 数和总时长
  const stats = useMemo(() => {
    const m = new Map<string, { count: number; durMs: number }>()
    for (const s of segments) {
      if (!s.characterId) continue
      const cur = m.get(s.characterId) ?? { count: 0, durMs: 0 }
      cur.count++
      cur.durMs += s.endMs - s.startMs
      m.set(s.characterId, cur)
    }
    return m
  }, [segments])

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs font-semibold text-zinc-400">
        角色 ({characters.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {characters.map((c) => {
          const stat = stats.get(c.id) ?? { count: 0, durMs: 0 }
          const cloned = !!c.voiceId
          return (
            <div
              key={c.id}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                cloned
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : 'border-amber-500/40 bg-amber-500/5'
              }`}
            >
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold ${
                  c.gender === 'male'
                    ? 'bg-sky-500/20 text-sky-300'
                    : c.gender === 'female'
                      ? 'bg-pink-500/20 text-pink-300'
                      : 'bg-zinc-700 text-zinc-300'
                }`}
              >
                {c.name?.slice(-2) ?? '?'}
              </div>
              <div>
                <div className="font-medium text-zinc-200">{c.name}</div>
                <div className="text-[10px] text-zinc-500">
                  {c.gender ?? '?'} · {stat.count}句 · {(stat.durMs / 1000).toFixed(1)}s
                </div>
              </div>
              <div className="ml-1 text-[10px]">
                {cloned ? (
                  <span className="text-emerald-300">✓ 克隆</span>
                ) : (
                  <span className="text-amber-300">系统音色</span>
                )}
                {c.useOriginalAudio && (
                  <span className="ml-1 text-amber-300" title="该角色历史全开原音（v0.4.22 字段保留，UI 已下线）">🎙️ 原音</span>
                )}
              </div>
              {/* v0.4.22 「使用原音」按钮已下线 —— 移到 SegmentDrawer 改为 segment 级
                   v0.4.19 「复制并复刻」也已下线 —— voice-clone-stage 自动 fallback */}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Segment 表 ──────────────────────────────────────────────────────

function SegmentTable({
  segments,
  characterById,
  selectedId,
  onSelect,
}: {
  segments: Segment[]
  characterById: Map<string, Character>
  selectedId: SegmentId | null
  onSelect: (id: SegmentId) => void
}): JSX.Element {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
          <tr className="border-b border-zinc-800">
            <th className="w-10 px-2 py-2 text-left">#</th>
            <th className="w-20 px-2 py-2 text-left">画面</th>
            <th className="w-24 px-2 py-2 text-left">角色</th>
            <th className="w-16 px-2 py-2 text-left">情绪</th>
            <th className="px-2 py-2 text-left">原文 / 译文</th>
            <th className="w-20 px-2 py-2 text-right">时长</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => {
            const c = s.characterId ? characterById.get(s.characterId) : null
            const isSel = s.id === selectedId
            const ttsDur = s.tgtDurMs ?? 0
            const srcDur = s.endMs - s.startMs
            const offset = ttsDur - srcDur
            return (
              <tr
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`cursor-pointer border-b border-zinc-800/40 transition ${
                  isSel ? 'bg-indigo-500/15' : 'hover:bg-zinc-800/40'
                }`}
              >
                <td className="px-2 py-2 text-zinc-500">{s.idx + 1}</td>
                <td className="px-2 py-2">
                  <Thumbnail path={s.thumbPath} />
                </td>
                <td className="px-2 py-2">
                  {c ? (
                    <div>
                      <div
                        className={`text-[11px] font-medium ${
                          c.gender === 'male'
                            ? 'text-sky-300'
                            : c.gender === 'female'
                              ? 'text-pink-300'
                              : 'text-zinc-300'
                        }`}
                      >
                        {c.name}
                      </div>
                      <div className="text-[9px] text-zinc-500">
                        {c.voiceId ? '克隆 ' + c.voiceId.slice(0, 8) : '系统'}
                      </div>
                    </div>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <EmotionPill emotion={s.emotion} />
                </td>
                <td className="px-2 py-2">
                  <div className="text-zinc-500 line-clamp-1">{s.srcText}</div>
                  <div className="text-zinc-200 line-clamp-1">
                    {s.tgtTextEdited ?? s.tgtText ?? '—'}
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <div className="text-zinc-400">{srcDur}ms</div>
                  <div
                    className={`text-[10px] ${
                      Math.abs(offset) < 200
                        ? 'text-zinc-500'
                        : offset > 0
                          ? 'text-rose-400'
                          : 'text-amber-400'
                    }`}
                  >
                    {ttsDur > 0
                      ? `${ttsDur}ms (${offset >= 0 ? '+' : ''}${offset})`
                      : '—'}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── 缩略图（懒加载） ──────────────────────────────────────────────

/**
 * v0.4.11 修复：thumbPath 一直存在但占位符 '画面' 始终显示——直接用 AssetImage 渲染
 * 若 thumbPath 为 null（segment 还没抽帧），显示灰色占位
 */
function Thumbnail({ path }: { path: string | null }): JSX.Element {
  if (!path) {
    return (
      <div className="flex h-10 w-16 items-center justify-center rounded bg-zinc-800 text-[9px] text-zinc-600">
        无画面
      </div>
    )
  }
  return <AssetImage path={path} className="h-10 w-16 rounded object-cover" />
}

// ─── 情绪标签 ──────────────────────────────────────────────────────

function EmotionPill({ emotion }: { emotion: string | null }): JSX.Element {
  if (!emotion || emotion === 'neutral') {
    return <span className="text-[10px] text-zinc-600">—</span>
  }
  const COLOR: Record<string, string> = {
    angry: 'bg-rose-500/20 text-rose-300',
    sad: 'bg-blue-500/20 text-blue-300',
    happy: 'bg-amber-500/20 text-amber-300',
    surprise: 'bg-purple-500/20 text-purple-300',
    surprised: 'bg-purple-500/20 text-purple-300',
    fear: 'bg-zinc-500/20 text-zinc-300',
    fearful: 'bg-zinc-500/20 text-zinc-300',
    disgust: 'bg-green-500/20 text-green-300',
    disgusted: 'bg-green-500/20 text-green-300',
  }
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${COLOR[emotion] ?? 'bg-zinc-700 text-zinc-300'}`}>
      {emotion}
    </span>
  )
}

// ─── Segment 详情区 ────────────────────────────────────────────────

function SegmentDetail({
  projectId,
  segmentId,
  segment,
  characters,
  onClose,
  onResynthDone,
}: {
  projectId: ProjectId
  segmentId: SegmentId
  segment: Segment | null
  characters: Character[]
  onClose: () => void
  onResynthDone: () => void
}): JSX.Element {
  const [assets, setAssets] = useState<SegmentAssets | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState({
    tgtText: '',
    emotion: '' as string,
    voiceId: '' as string,
    intensity: '' as string,
    speed: '' as string,
    vol: '' as string,
  })
  const [resyncing, setResyncing] = useState(false)
  // v0.4.12 resynth 计数器：重合成时递增 → 触发 <audio> key 变更强制 remount
  // 修复"重合成后播放还是旧音频"bug：之前同名覆盖 mp3 但 React 不重新加载 dataUrl
  const [resynthRev, setResynthRev] = useState(0)
  // v0.4.22 segment 级"使用原音"——只切这一句，不影响该角色其他 segments
  const [segUseOriginal, setSegUseOriginal] = useState(!!segment?.useOriginalAudio)
  useEffect(() => {
    setSegUseOriginal(!!segment?.useOriginalAudio)
  }, [segment?.id, segment?.useOriginalAudio])

  useEffect(() => {
    setLoading(true)
    setAssets(null)
    void api
      .call('segment:assets', { projectId, segmentId })
      .then((a) => {
        setAssets(a)
        setEditing({
          tgtText: segment?.tgtTextEdited ?? segment?.tgtText ?? '',
          emotion: segment?.emotion ?? '',
          voiceId: a.ttsVoiceId ?? '',
          intensity: a.ttsParams?.emotionIntensity?.toString() ?? '',
          speed: a.ttsParams?.speed?.toString() ?? '',
          vol: a.ttsParams?.vol?.toString() ?? '',
        })
      })
      .finally(() => setLoading(false))
  }, [projectId, segmentId, segment?.tgtText, segment?.tgtTextEdited])

  const doResynth = async (): Promise<void> => {
    setResyncing(true)
    try {
      await api.call('segment:resynth', {
        projectId,
        segmentId,
        overrides: {
          tgtText: editing.tgtText || undefined,
          emotion: editing.emotion || null,
          voiceId: editing.voiceId || undefined,
          emotionIntensity: editing.intensity ? Number(editing.intensity) : undefined,
          speed: editing.speed ? Number(editing.speed) : undefined,
          vol: editing.vol ? Number(editing.vol) : undefined,
        },
      })
      // 刷新 assets
      const fresh = await api.call('segment:assets', { projectId, segmentId })
      setAssets(fresh)
      // v0.4.12 强制 audio 重读：同名覆盖的 mp3 不会触发 React useEffect 重跑
      // 通过 resynthRev 自增 + audio 用 key={resynthRev} 强制 unmount/remount
      setResynthRev((n) => n + 1)
      onResynthDone()
    } finally {
      setResyncing(false)
    }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-500">
          加载选中 segment 资产…
        </div>
      </div>
    )
  }
  if (!assets || !segment) return <></>

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="flex h-[28rem] w-[64rem] max-w-[95vw] gap-3 rounded-lg border border-indigo-500/40 bg-zinc-900/95 p-4 shadow-2xl">
        {/* 左：3 个音频对比 + 缩略图 */}
        <div className="flex w-72 flex-col gap-2 text-xs">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase text-zinc-500">
              #{segment.idx + 1} · {assets.startMs}–{assets.endMs}ms
            </div>
            {/* ★ v0.4.11 关闭按钮 — 浮层 close */}
            <button
              onClick={onClose}
              title="关闭详情（不挤压表格）"
              className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
          </div>
          {assets.thumbPath && (
            <AssetImage path={assets.thumbPath} className="h-28 w-full rounded object-cover" />
          )}
          <AssetAudio label="原音" path={assets.srcAudioPath} />
          <AssetAudio label="克隆样本" path={assets.cloneSamplePath} />
          {/* v0.4.12 TTS 产物传 revKey：resynth 时同名覆盖 mp3，强制重新读 dataUrl */}
          <AssetAudio label="TTS 产物" path={assets.ttsAudioPath} revKey={resynthRev} />
        </div>

        {/* 中 + 右：可编辑表单 */}
        <div className="flex-1 overflow-auto">
          <div className="mb-2 grid grid-cols-3 gap-2 text-[11px]">
            <Field label="角色">
              <span className="text-zinc-300">{assets.characterName ?? '—'}</span>
            </Field>
            <Field label="情绪">
              <select
                value={editing.emotion}
                onChange={(e) => setEditing({ ...editing, emotion: e.target.value })}
                className="w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200"
              >
                <option value="">（自动）</option>
                <option value="neutral">neutral</option>
                <option value="happy">happy</option>
                <option value="sad">sad</option>
                <option value="angry">angry</option>
                <option value="surprised">surprised</option>
                <option value="fearful">fearful</option>
                <option value="disgusted">disgusted</option>
              </select>
            </Field>
            <Field label="Voice ID">
              <select
                value={editing.voiceId}
                onChange={(e) => setEditing({ ...editing, voiceId: e.target.value })}
                className="w-full rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-200"
              >
                <option value="">（按角色默认）</option>
                {characters.map((c) =>
                  c.voiceId ? (
                    <option key={c.id} value={c.voiceId}>
                      {c.name} · {c.voiceId.slice(0, 12)}
                    </option>
                  ) : null,
                )}
                <optgroup label="系统音色（女）">
                  <option value="female-shaonv">female-shaonv</option>
                  <option value="female-tianmei">female-tianmei</option>
                  <option value="female-yujie">female-yujie</option>
                  <option value="female-chengshu">female-chengshu</option>
                </optgroup>
                <optgroup label="系统音色（男）">
                  <option value="male-qn-jingying">male-qn-jingying</option>
                  <option value="male-qn-qingse">male-qn-qingse</option>
                  <option value="male-qn-badao">male-qn-badao</option>
                </optgroup>
              </select>
            </Field>
            <Field label="音量 0-10">
              <input
                type="number"
                step={0.1}
                min={0}
                max={10}
                value={editing.vol}
                onChange={(e) => setEditing({ ...editing, vol: e.target.value })}
                placeholder="自动"
                className="w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200"
              />
            </Field>
            <Field label="强度 0.5-2.0">
              <input
                type="number"
                step="0.1"
                min={0.5}
                max={2}
                value={editing.intensity}
                onChange={(e) => setEditing({ ...editing, intensity: e.target.value })}
                placeholder="自动"
                className="w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200"
              />
            </Field>
            <Field label="语速 0.5-2.0">
              <input
                type="number"
                step="0.05"
                min={0.5}
                max={2}
                value={editing.speed}
                onChange={(e) => setEditing({ ...editing, speed: e.target.value })}
                placeholder="自动"
                className="w-full rounded bg-zinc-800 px-1 py-0.5 text-zinc-200"
              />
            </Field>
            <Field label="TTS 时长">
              <span className="text-zinc-400">{assets.ttsDurMs ?? '—'}ms</span>
            </Field>
          </div>

          <Field label="原文（中）">
            <div className="rounded bg-zinc-800/50 px-2 py-1 text-zinc-400">{segment.srcText}</div>
          </Field>
          <Field label="译文（可编辑）">
            <textarea
              value={editing.tgtText}
              onChange={(e) => setEditing({ ...editing, tgtText: e.target.value })}
              rows={2}
              className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-200"
            />
          </Field>
          {assets.ttsInputText && assets.ttsInputText !== editing.tgtText && (
            <Field label="实际送进 TTS 的文本（含停顿标记）">
              <div className="rounded bg-zinc-800/50 px-2 py-1 font-mono text-[10px] text-amber-300">
                {assets.ttsInputText}
              </div>
            </Field>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded border border-zinc-700 px-3 py-1.5 text-[11px] hover:bg-zinc-800"
            >
              关闭
            </button>
            <button
              disabled={resyncing}
              onClick={() => void doResynth()}
              className="rounded bg-indigo-500 px-3 py-1.5 text-[11px] hover:bg-indigo-400 disabled:opacity-50"
            >
              {resyncing ? '合成中…' : '↻ 重合成这一句'}
            </button>
            {/* v0.4.22 「使用原音」改为 segment 级——只切这一句 */}
            <button
              disabled={!segment || !assets?.srcAudioPath}
              onClick={() => {
                if (!segment) return
                const next = !segUseOriginal
                setSegUseOriginal(next)  // 乐观更新
                void api
                  .call('segment:set-use-original-audio', {
                    projectId: projectId as any,
                    segmentId: segment.id,
                    useOriginalAudio: next,
                  })
                  .then(() => onResynthDone?.())
                  .catch(() => setSegUseOriginal(!next))  // 失败回滚
              }}
              className={`rounded px-3 py-1.5 text-[11px] disabled:opacity-50 ${
                segUseOriginal
                  ? 'bg-amber-500 text-zinc-900 hover:bg-amber-400 ring-2 ring-amber-300'
                  : 'border border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
              }`}
              title="仅这一句在 mix-render 时用原音替代 TTS 产物（不影响该角色其他句子）"
            >
              {segUseOriginal ? '🎙️ 使用原音 ✓' : '使用原音'}
            </button>
            {/* v0.4.19 P2「复制并复刻」按钮已下线 —— voice-clone-stage 自动 fallback */}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="mb-1">
      <div className="mb-0.5 text-[10px] text-zinc-500">{label}</div>
      {children}
    </div>
  )
}

// ─── 资产文件懒加载 ────────────────────────────────────────────────

function AssetAudio({
  label,
  path,
  revKey = 0,
}: {
  label: string
  path: string | null
  /** v0.4.12 resynth 时自增，强制 audio 重新读 dataUrl（同路径覆盖 mp3 场景） */
  revKey?: number
}): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDataUrl(null)
    setError(null)
    if (!path) return
    void api
      .call('system:read-file-as-data-url', { path, mimeHint: 'audio' })
      .then((r) => setDataUrl(r.dataUrl))
      .catch((e) => setError(String(e.message ?? e)))
  }, [path, revKey])

  return (
    <div className="rounded bg-zinc-800/50 p-1.5">
      <div className="mb-0.5 text-[10px] text-zinc-500">{label}</div>
      {!path ? (
        <div className="text-[10px] text-zinc-600">（无）</div>
      ) : error ? (
        <div className="text-[10px] text-rose-400">{error.slice(0, 50)}</div>
      ) : !dataUrl ? (
        <div className="text-[10px] text-zinc-600">加载中…</div>
      ) : (
        <audio controls src={dataUrl} className="h-7 w-full" />
      )}
    </div>
  )
}

function AssetImage({
  path,
  className,
}: {
  path: string
  className?: string
}): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    void api
      .call('system:read-file-as-data-url', { path, mimeHint: 'image' })
      .then((r) => setDataUrl(r.dataUrl))
      .catch(() => setDataUrl(null))
  }, [path])
  if (!dataUrl) return <div className={`bg-zinc-800 ${className ?? ''}`} />
  return <img src={dataUrl} className={className} alt="" />
}
