import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/index.js'
import type {
  OriginalAudioRange,
  ProjectDetail,
  ProjectId,
} from '@dramaprime/core-types'

interface Props {
  projectId: ProjectId
  project: ProjectDetail | null
  onProjectChange: (p: ProjectDetail) => void
}

type Tool = 'select' | 'brush'

interface PreprocessMeta {
  fps: number
  width: number
  height: number
  durationMs: number
  thumbnails: string[]
}

type DragMode =
  | { kind: 'brush'; startedAtMs: number; currentPx: number; startPx: number }
  | { kind: 'edge'; rangeId: string; edge: 'start' | 'end'; anchorMs: number }

export function PreprocessPanel({
  projectId,
  project,
  onProjectChange,
}: Props): JSX.Element {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [preMeta, setPreMeta] = useState<PreprocessMeta | null>(null)
  const [tool, setTool] = useState<Tool>('brush')
  const [snapToFrame, setSnapToFrame] = useState(true)
  const [showFrameNum, setShowFrameNum] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [durationMs, setDurationMs] = useState<number>(project?.sourceDurMs ?? 0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragMode | null>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [ranges, setRanges] = useState<OriginalAudioRange[]>(
    project?.config.originalAudioRanges ?? [],
  )

  useEffect(() => {
    setRanges(project?.config.originalAudioRanges ?? [])
    setDurationMs(project?.sourceDurMs ?? 0)
  }, [project])

  // 删除单个片段 —— 统一入口，多处调用
  const deleteRange = useCallback((id: string) => {
    setRanges((rs) => rs.filter((x) => x.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [])

  // Delete / Backspace 键删除选中片段（输入框获焦时不响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteRange(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteRange])

  useEffect(() => {
    if (!projectId) return
    setVideoUrl(null)
    setVideoError(null)
    setPreMeta(null)
    void api
      .call('project:register-source-preview', { id: projectId })
      .then((res) => setVideoUrl(res.url))
      .catch((err) => setVideoError(`视频加载失败：${err.message ?? err}`))
    void api
      .call('project:get-preprocess-meta', { id: projectId })
      .then((meta) => {
        if (meta) setPreMeta(meta)
        if (meta && meta.durationMs > 0) setDurationMs(meta.durationMs)
      })
      .catch(() => {})
  }, [projectId])

  const rangesJson = JSON.stringify(ranges)
  const lastSavedJson = useRef<string>(
    JSON.stringify(project?.config.originalAudioRanges ?? []),
  )
  useEffect(() => {
    if (rangesJson === lastSavedJson.current) return
    const t = window.setTimeout(async () => {
      try {
        await api.call('project:set-original-audio-ranges', {
          id: projectId,
          ranges,
        })
        lastSavedJson.current = rangesJson
        const fresh = await api.call('project:get', projectId)
        onProjectChange(fresh)
      } catch (err) {
        console.error('保存 originalAudioRanges 失败', err)
      }
    }, 500)
    return () => window.clearTimeout(t)
  }, [rangesJson, projectId, ranges, onProjectChange])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentMs(Math.round(v.currentTime * 1000))
    const onLoaded = () => {
      const dm = Math.round(v.duration * 1000)
      if (dm > 0) setDurationMs(dm)
      setVideoError(null)
    }
    const onErr = () => {
      const err = v.error
      setVideoError(
        err ? `视频错误 (code=${err.code}): ${err.message || '未知'}` : '视频加载失败',
      )
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('error', onErr)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('error', onErr)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [videoUrl])

  const fps = preMeta?.fps && preMeta.fps > 0 ? preMeta.fps : 0
  const frameDurMs = fps > 0 ? 1000 / fps : 0

  const snap = useCallback(
    (ms: number): number => {
      if (!snapToFrame || frameDurMs <= 0) return Math.max(0, Math.round(ms))
      const frame = Math.round(ms / frameDurMs)
      const snapped = Math.round(frame * frameDurMs)
      return Math.max(0, Math.min(durationMs || snapped, snapped))
    },
    [snapToFrame, frameDurMs, durationMs],
  )

  const totalCoveredMs = useMemo(
    () => ranges.reduce((s, r) => s + (r.endMs - r.startMs), 0),
    [ranges],
  )

  const pxToMs = useCallback(
    (px: number): number => {
      const tl = timelineRef.current
      if (!tl || durationMs <= 0) return 0
      const rect = tl.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (px - rect.left) / rect.width))
      return Math.round(ratio * durationMs)
    },
    [durationMs],
  )

  const msToPercent = useCallback(
    (ms: number): number => {
      if (durationMs <= 0) return 0
      return Math.max(0, Math.min(100, (ms / durationMs) * 100))
    },
    [durationMs],
  )

  const seekTo = (ms: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, ms / 1000)
  }

  // ── 时间轴交互 ────────────────────────────
  const onTimelineMouseDown = (e: React.MouseEvent) => {
    if (durationMs <= 0) return
    if (tool === 'select') {
      // 选择工具：点击直接 seek
      seekTo(snap(pxToMs(e.clientX)))
      return
    }
    const ms = snap(pxToMs(e.clientX))
    setDrag({ kind: 'brush', startedAtMs: ms, startPx: e.clientX, currentPx: e.clientX })
    e.preventDefault()
  }

  const onEdgeMouseDown = (
    e: React.MouseEvent,
    rangeId: string,
    edge: 'start' | 'end',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    const r = ranges.find((x) => x.id === rangeId)
    if (!r) return
    const anchorMs = edge === 'start' ? r.endMs : r.startMs
    setDrag({ kind: 'edge', rangeId, edge, anchorMs })
  }

  const onTimelineMouseMove = (e: React.MouseEvent) => {
    if (durationMs <= 0) return
    setHoverMs(pxToMs(e.clientX))
  }
  const onTimelineMouseLeave = () => setHoverMs(null)

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      if (drag.kind === 'brush') {
        setDrag({ ...drag, currentPx: e.clientX })
      } else {
        const snapped = snap(pxToMs(e.clientX))
        setRanges((rs) =>
          rs.map((r) => {
            if (r.id !== drag.rangeId) return r
            if (drag.edge === 'start') {
              return { ...r, startMs: Math.min(snapped, r.endMs - 50) }
            } else {
              return { ...r, endMs: Math.max(snapped, r.startMs + 50) }
            }
          }),
        )
      }
    }
    const onUp = (e: MouseEvent) => {
      if (drag.kind === 'brush') {
        const endMs = snap(pxToMs(e.clientX))
        const startMs = Math.min(drag.startedAtMs, endMs)
        const finalEnd = Math.max(drag.startedAtMs, endMs)
        if (finalEnd - startMs >= 200) {
          setRanges((rs) => [
            ...rs,
            {
              id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              startMs,
              endMs: finalEnd,
            },
          ])
        }
      }
      setDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, pxToMs, snap])

  const brushPreview = useMemo(() => {
    if (!drag || drag.kind !== 'brush') return null
    const a = snap(pxToMs(Math.min(drag.startPx, drag.currentPx)))
    const b = snap(pxToMs(Math.max(drag.startPx, drag.currentPx)))
    return { startMs: a, endMs: b }
  }, [drag, pxToMs, snap])

  const fmt = (ms: number) => formatTime(ms, showFrameNum ? fps : 0)
  const coveragePct = durationMs > 0 ? (totalCoveredMs / durationMs) * 100 : 0

  if (!project) {
    return (
      <div className="flex flex-1 items-center justify-center text-zinc-500">加载中…</div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ═══ 上部：视频 + 状态卡 ═══════════════════════════════════ */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4 pb-2">
        {/* 视频区 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800/80 bg-gradient-to-b from-zinc-900 to-black shadow-inner">
          <div className="flex flex-1 items-center justify-center overflow-hidden bg-black">
            {videoError ? (
              <div className="max-w-md p-6 text-center">
                <div className="mb-2 text-2xl">⚠️</div>
                <div className="text-sm text-rose-300">{videoError}</div>
                <div className="mt-2 text-xs text-zinc-500 break-all">{project.sourcePath}</div>
              </div>
            ) : videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="h-full w-full object-contain"
                preload="metadata"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-xs text-zinc-500">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" />
                加载视频中…
              </div>
            )}
          </div>
        </div>

        {/* 右侧信息面板 */}
        <div className="flex w-72 shrink-0 flex-col gap-3 overflow-auto">
          <InfoCard
            icon="🎬"
            title="保留原音"
            body="用刷子在时间轴上框选片段——最终成片这些段落将保留源视频原音，不做译制、不显示字幕。适合武打、笑声、氛围声等场景。"
            tone="indigo"
          />

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              统计
            </div>
            <StatRow label="片段数量" value={String(ranges.length)} accent="text-indigo-300" />
            <StatRow label="覆盖时长" value={fmt(totalCoveredMs)} />
            <StatRow label="覆盖占比" value={`${coveragePct.toFixed(1)}%`} />
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-500 transition-all"
                style={{ width: `${Math.min(100, coveragePct)}%` }}
              />
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              视频
            </div>
            <StatRow label="总时长" value={fmt(durationMs)} />
            {preMeta && (
              <>
                <StatRow
                  label="分辨率"
                  value={preMeta.width && preMeta.height ? `${preMeta.width}×${preMeta.height}` : '—'}
                />
                <StatRow label="帧率" value={fps > 0 ? `${fps.toFixed(2)} fps` : '—'} />
              </>
            )}
            {!preMeta && (
              <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
                未跑过预处理 · 缩略图和帧号不可用
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ 中部：工具栏 + 时间轴 ══════════════════════════════════ */}
      <div className="px-4 pb-2">
        <Toolbar
          tool={tool}
          setTool={setTool}
          playing={playing}
          onPlayPause={() => {
            const v = videoRef.current
            if (!v) return
            if (v.paused) void v.play()
            else v.pause()
          }}
          fps={fps}
          snapToFrame={snapToFrame}
          setSnapToFrame={setSnapToFrame}
          showFrameNum={showFrameNum}
          setShowFrameNum={setShowFrameNum}
          canUndo={ranges.length > 0}
          onUndo={() => setRanges((rs) => rs.slice(0, -1))}
          currentMs={currentMs}
          durationMs={durationMs}
          hoverMs={hoverMs}
          fmt={fmt}
        />

        {/* 时间轴 */}
        <div
          ref={timelineRef}
          onMouseDown={onTimelineMouseDown}
          onMouseMove={onTimelineMouseMove}
          onMouseLeave={onTimelineMouseLeave}
          className={`relative mt-2 h-24 select-none overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950 shadow-inner ${
            tool === 'brush' ? 'cursor-crosshair' : 'cursor-pointer'
          }`}
        >
          {/* 缩略图背景层 */}
          {preMeta?.thumbnails.length ? (
            <>
              <div className="pointer-events-none absolute inset-0 flex">
                {preMeta.thumbnails.map((url, i) => (
                  <div
                    key={i}
                    className="h-full flex-1 bg-cover bg-center"
                    style={{ backgroundImage: `url(${url})` }}
                  />
                ))}
              </div>
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-black/60" />
            </>
          ) : (
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[length:60px_100%]" />
          )}

          {/* 时间刻度（10 段） */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex h-3">
            {Array.from({ length: 11 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 border-l border-white/10 first:border-l-0 last:border-r-0"
              />
            ))}
          </div>

          {/* 已有 range */}
          {ranges.map((r) => {
            const isDraggingThis = drag?.kind === 'edge' && drag.rangeId === r.id
            const isSelected = selectedId === r.id
            return (
              <div
                key={r.id}
                onMouseDown={(e) => {
                  // 点中 range 本体（非把手/按钮）→ 选中；阻止冒泡避免触发 brush 新建
                  e.stopPropagation()
                  setSelectedId(r.id)
                }}
                className={`group absolute top-4 bottom-4 rounded-md backdrop-blur-sm transition-all ${
                  isDraggingThis
                    ? 'bg-amber-400/70 shadow-lg shadow-amber-500/30 ring-2 ring-amber-300'
                    : isSelected
                      ? 'bg-amber-400/60 shadow-lg shadow-amber-500/40 ring-2 ring-amber-200'
                      : 'bg-amber-400/50 shadow-md shadow-amber-500/20 ring-1 ring-amber-300/70 hover:bg-amber-400/60'
                }`}
                style={{
                  left: `${msToPercent(r.startMs)}%`,
                  width: `${msToPercent(r.endMs - r.startMs)}%`,
                  cursor: 'pointer',
                }}
                title={`${fmt(r.startMs)} — ${fmt(r.endMs)}${r.note ? ` · ${r.note}` : ''}\n点击选中 · Delete 键删除`}
              >
                {/* 左把手 */}
                <div
                  onMouseDown={(e) => onEdgeMouseDown(e, r.id, 'start')}
                  className="absolute -left-1.5 top-0 bottom-0 flex w-3 cursor-ew-resize items-center justify-center"
                >
                  <div className="h-full w-1 rounded-full bg-amber-200 opacity-70 shadow-md group-hover:opacity-100" />
                </div>
                {/* 右把手 */}
                <div
                  onMouseDown={(e) => onEdgeMouseDown(e, r.id, 'end')}
                  className="absolute -right-1.5 top-0 bottom-0 flex w-3 cursor-ew-resize items-center justify-center"
                >
                  <div className="h-full w-1 rounded-full bg-amber-200 opacity-70 shadow-md group-hover:opacity-100" />
                </div>
                {/* 右上角✕删除按钮（悬停或选中时显示） */}
                {msToPercent(r.endMs - r.startMs) > 3 && (
                  <button
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteRange(r.id)
                    }}
                    className={`absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow-md transition-opacity hover:bg-rose-400 ${
                      isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    title="删除这段"
                  >
                    ×
                  </button>
                )}
                {/* 中间标签（宽度够时显示） */}
                {msToPercent(r.endMs - r.startMs) > 8 && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-medium text-amber-950/80">
                    {fmt(r.endMs - r.startMs)}
                  </div>
                )}
              </div>
            )
          })}

          {/* 刷子预览 */}
          {brushPreview && brushPreview.endMs > brushPreview.startMs && (
            <div
              className="pointer-events-none absolute top-4 bottom-4 rounded-md bg-amber-300/60 ring-2 ring-amber-200"
              style={{
                left: `${msToPercent(brushPreview.startMs)}%`,
                width: `${msToPercent(brushPreview.endMs - brushPreview.startMs)}%`,
              }}
            />
          )}

          {/* hover 时间提示 */}
          {hoverMs !== null && !drag && (
            <div
              className="pointer-events-none absolute -top-1 h-2 w-px bg-zinc-400/60"
              style={{ left: `${msToPercent(hoverMs)}%` }}
            >
              <div className="absolute left-1/2 top-full -translate-x-1/2 mt-0.5 whitespace-nowrap rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200 shadow">
                {fmt(hoverMs)}
              </div>
            </div>
          )}

          {/* 当前时间游标 */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.9)]"
            style={{ left: `${msToPercent(currentMs)}%` }}
          >
            <div className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-indigo-400" />
          </div>
        </div>
      </div>

      {/* ═══ 下部：片段列表 ══════════════════════════════════════ */}
      <div className="mx-4 mb-4 flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40">
        <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/60 px-4 py-2">
          <div className="flex items-center gap-3 text-xs font-semibold text-zinc-300">
            <span>保留原音片段</span>
            <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] text-indigo-300">
              {ranges.length}
            </span>
            <span className="text-[10px] font-normal text-zinc-500">
              修改自动保存 · 「字幕烧录」「视频合成」会变为待重跑
            </span>
          </div>
          <button
            onClick={() => {
              if (ranges.length === 0) return
              if (!confirm(`清空全部 ${ranges.length} 个片段？此操作不可撤销。`)) return
              setRanges([])
              setSelectedId(null)
            }}
            disabled={ranges.length === 0}
            className="rounded-md border border-rose-700/40 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-30"
            title="清空所有片段"
          >
            清空全部
          </button>
        </div>
        {ranges.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-zinc-500">
            <div>
              <div className="mb-1 text-2xl opacity-40">🖌</div>
              还没有片段——切到刷子工具，在时间轴上按住拖动来画一个
            </div>
          </div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-zinc-800/60 overflow-auto">
            {ranges.map((r, i) => {
              const isSelected = selectedId === r.id
              return (
              <li
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={`group flex items-center gap-3 px-4 py-2 text-xs cursor-pointer ${
                  isSelected ? 'bg-amber-500/10' : 'hover:bg-zinc-800/40'
                }`}
              >
                <span className={`w-8 ${isSelected ? 'text-amber-300' : 'text-zinc-500'}`}>
                  #{i + 1}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    seekTo(r.startMs)
                  }}
                  className="flex items-center justify-center rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-indigo-400 hover:border-indigo-500/60 hover:text-indigo-300"
                  title="跳到起点播放"
                >
                  ▶
                </button>
                <TimeInput
                  valueMs={r.startMs}
                  displayFps={showFrameNum ? fps : 0}
                  onCommit={(next) => {
                    // 边界：start < end；snap 到帧（若开启）；clamp 到视频时长
                    const clamped = Math.max(0, Math.min(next, r.endMs - 50))
                    const snapped = snap(clamped)
                    setRanges((rs) =>
                      rs.map((x) => (x.id === r.id ? { ...x, startMs: snapped } : x)),
                    )
                  }}
                />
                <span className="text-zinc-600">→</span>
                <TimeInput
                  valueMs={r.endMs}
                  displayFps={showFrameNum ? fps : 0}
                  onCommit={(next) => {
                    const clamped = Math.max(
                      r.startMs + 50,
                      Math.min(next, durationMs || next),
                    )
                    const snapped = snap(clamped)
                    setRanges((rs) =>
                      rs.map((x) => (x.id === r.id ? { ...x, endMs: snapped } : x)),
                    )
                  }}
                />
                <span
                  className="rounded bg-amber-500/10 px-2 py-1 font-mono text-amber-300"
                  title="片段时长"
                >
                  {fmt(r.endMs - r.startMs)}
                </span>
                <input
                  value={r.note ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const note = e.target.value
                    setRanges((rs) => rs.map((x) => (x.id === r.id ? { ...x, note } : x)))
                  }}
                  placeholder='添加备注…'
                  className="flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-zinc-200 placeholder-zinc-600 hover:border-zinc-700 focus:border-indigo-500 focus:outline-none"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteRange(r.id)
                  }}
                  className="flex items-center gap-1 rounded-md border border-rose-700/40 bg-rose-500/5 px-2 py-1 text-rose-300 hover:bg-rose-500/15 hover:text-rose-200"
                  title="删除这段"
                >
                  <span>✕</span>
                  <span>删除</span>
                </button>
              </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

// ─── 子组件 ─────────────────────────────────────────────────────────

function InfoCard({
  icon,
  title,
  body,
  tone,
}: {
  icon: string
  title: string
  body: string
  tone: 'indigo' | 'amber'
}): JSX.Element {
  const toneMap = {
    indigo: 'border-indigo-500/20 bg-indigo-500/5 text-indigo-100',
    amber: 'border-amber-500/20 bg-amber-500/5 text-amber-100',
  }
  return (
    <div className={`rounded-xl border p-4 ${toneMap[tone]}`}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold">
        <span className="text-sm">{icon}</span>
        {title}
      </div>
      <div className="text-[11px] leading-relaxed opacity-80">{body}</div>
    </div>
  )
}

function StatRow({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: string
}): JSX.Element {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className={`font-mono ${accent ?? 'text-zinc-200'}`}>{value}</span>
    </div>
  )
}

function Toolbar({
  tool,
  setTool,
  playing,
  onPlayPause,
  fps,
  snapToFrame,
  setSnapToFrame,
  showFrameNum,
  setShowFrameNum,
  canUndo,
  onUndo,
  currentMs,
  durationMs,
  hoverMs,
  fmt,
}: {
  tool: Tool
  setTool: (t: Tool) => void
  playing: boolean
  onPlayPause: () => void
  fps: number
  snapToFrame: boolean
  setSnapToFrame: (v: boolean) => void
  showFrameNum: boolean
  setShowFrameNum: (v: boolean) => void
  canUndo: boolean
  onUndo: () => void
  currentMs: number
  durationMs: number
  hoverMs: number | null
  fmt: (ms: number) => string
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-3 py-2 text-xs backdrop-blur">
      {/* 播放控件 */}
      <button
        onClick={onPlayPause}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-500 text-white hover:bg-indigo-400"
        title={playing ? '暂停' : '播放'}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <div className="mx-1 h-4 w-px bg-zinc-700" />

      {/* 工具选择 */}
      <div className="flex overflow-hidden rounded-md border border-zinc-700 bg-zinc-950">
        <ToolButton
          active={tool === 'select'}
          onClick={() => setTool('select')}
          label="选择"
          icon="⇅"
          hint="点击时间轴 seek"
        />
        <ToolButton
          active={tool === 'brush'}
          onClick={() => setTool('brush')}
          label="刷子"
          icon="🖌"
          hint="按住拖动画选段"
        />
      </div>

      <div className="mx-1 h-4 w-px bg-zinc-700" />

      {/* 撤销 / 清空 */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
        title="撤销最后一段"
      >
        ↺
      </button>

      <div className="mx-1 h-4 w-px bg-zinc-700" />

      {/* 帧对齐 / 帧号 */}
      <ToggleChip
        active={snapToFrame && fps > 0}
        disabled={fps <= 0}
        onChange={setSnapToFrame}
        label="帧对齐"
        hint={fps > 0 ? `按 ${fps.toFixed(2)}fps 吸附` : '需先跑预处理'}
      />
      <ToggleChip
        active={showFrameNum && fps > 0}
        disabled={fps <= 0}
        onChange={setShowFrameNum}
        label="帧号"
        hint="时间戳后附加帧号"
      />

      {/* 时间显示 靠右 */}
      <div className="ml-auto flex items-center gap-3 font-mono text-[11px]">
        {hoverMs !== null && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-300">
            {fmt(hoverMs)}
          </span>
        )}
        <span className="text-indigo-300">{fmt(currentMs)}</span>
        <span className="text-zinc-600">/</span>
        <span className="text-zinc-400">{fmt(durationMs)}</span>
      </div>
    </div>
  )
}

function ToolButton({
  active,
  onClick,
  label,
  icon,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: string
  hint: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={`flex items-center gap-1.5 px-3 py-1 transition ${
        active
          ? 'bg-indigo-500 text-white shadow-inner'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function ToggleChip({
  active,
  disabled,
  onChange,
  label,
  hint,
}: {
  active: boolean
  disabled: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}): JSX.Element {
  return (
    <button
      onClick={() => !disabled && onChange(!active)}
      disabled={disabled}
      title={hint}
      className={`rounded-md border px-2 py-1 transition ${
        disabled
          ? 'cursor-not-allowed border-zinc-800 text-zinc-600'
          : active
            ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-200'
            : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  )
}

const formatTime = (ms: number, fps: number): string => {
  const safe = Math.max(0, ms | 0)
  const totalSec = safe / 1000
  const min = Math.floor(totalSec / 60)
  const sec = totalSec - min * 60
  const base = `${min}:${sec.toFixed(3).padStart(6, '0')}`
  if (fps > 0) {
    const frame = Math.round(safe / (1000 / fps))
    return `${base} · ${frame}f`
  }
  return base
}

// ─── 内联可编辑的时间输入 ─────────────────────────────────────────────

/**
 * 可编辑时间戳组件：
 *   - 未 focus 时显示格式化时间（0:03.500 · 105f），像 label 一样
 *   - focus 时切成 input，允许用户改；显示原始 ms 便于精确输入
 *   - Enter / blur → 尝试解析并提交；解析失败则回退到 originalMs（红闪一下）
 *   - Esc → 放弃编辑
 *
 * 解析格式支持见 parseTimeInput 注释。
 */
function TimeInput({
  valueMs,
  displayFps,
  onCommit,
}: {
  valueMs: number
  displayFps: number
  onCommit: (nextMs: number) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [errorFlash, setErrorFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEdit = () => {
    // 编辑时用简洁的默认值：M:SS.mmm；用户可以自己改成其他格式
    setDraft(formatTime(valueMs, 0))
    setEditing(true)
    // focus 后全选，方便直接覆盖
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  const commit = () => {
    const parsed = parseTimeInput(draft, displayFps)
    if (parsed == null) {
      // 解析失败：红闪一下、保持编辑状态让用户继续改
      setErrorFlash(true)
      setTimeout(() => setErrorFlash(false), 600)
      return
    }
    onCommit(parsed)
    setEditing(false)
  }

  const cancel = () => setEditing(false)

  if (!editing) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          startEdit()
        }}
        className="rounded border border-transparent bg-zinc-900 px-2 py-1 font-mono text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        title="点击编辑（支持 M:SS.mmm / 3.5s / 3500ms / 120f）"
      >
        {formatTime(valueMs, displayFps)}
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation() // 别让 Delete/Backspace 键冒到 window 触发 range 删除
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') cancel()
      }}
      onBlur={commit}
      className={`w-28 rounded border px-2 py-1 font-mono focus:outline-none ${
        errorFlash
          ? 'border-rose-500 bg-rose-500/10 text-rose-200'
          : 'border-indigo-500 bg-zinc-950 text-zinc-100'
      }`}
      placeholder="0:03.500"
    />
  )
}

/**
 * 解析用户输入的时间字符串，返回毫秒；无法识别时返回 null。
 *
 * 支持的格式（都要接受，也要有明确的容错）：
 *   1. "M:SS.mmm"       → 分:秒.毫秒         例：0:03.500 / 12:45.230
 *   2. "SS.mmm"         → 纯秒（含小数）      例：3.5 / 12.75
 *   3. "3.5s"           → 秒 + 单位后缀       例：0.25s / 12.5s
 *   4. "3500ms"         → 毫秒                例：3500ms / 250ms
 *   5. "120f"           → 帧号（需 fps>0）     例：120f → 120 * (1000/fps) ms
 *
 * 容错建议：
 *   - 空字符串或纯空格 → null
 *   - 数字带负号 → null（时间不能为负）
 *   - 超大数（比如 24h+）→ 允许，交给上层 clamp
 *   - 前后空格自动 trim
 *
 * ⚠️ 这个函数留给你按业务偏好实现。当前是一个最简 fallback：只识别 M:SS.mmm 和 SS.mmm。
 *    实现完后删掉 TODO 注释。
 */
export function parseTimeInput(raw: string, fps: number): number | null {
  const s = raw.trim()
  if (!s) return null
  // TODO(user): 请实现下列格式的解析。以下是最简 fallback，只覆盖两种。
  //   支持 5 种格式：M:SS.mmm / SS.mmm / Ns / Nms / Nf
  //   fps 参数：格式 5（帧号）用；fps<=0 时应对帧号输入返回 null
  const mColon = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  if (mColon) {
    const min = Number(mColon[1])
    const sec = Number(mColon[2])
    if (isFinite(min) && isFinite(sec)) return Math.round((min * 60 + sec) * 1000)
  }
  const mSec = /^(\d+(?:\.\d+)?)$/.exec(s)
  if (mSec) {
    const sec = Number(mSec[1])
    if (isFinite(sec)) return Math.round(sec * 1000)
  }
  // 其它格式暂不识别，用户会看到红色错误提示
  void fps
  return null
}
