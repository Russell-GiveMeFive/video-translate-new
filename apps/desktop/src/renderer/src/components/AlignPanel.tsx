import { useEffect, useState } from 'react'
import { api } from '../api/index.js'
import type { ProjectId, Segment } from '@dramaprime/core-types'

const STRATEGY_LABEL: Record<string, { label: string; color: string }> = {
  fit: { label: '完美', color: 'text-emerald-300 bg-emerald-500/10' },
  speed: { label: 'TTS 调速', color: 'text-emerald-300 bg-emerald-500/10' },
  sola: { label: 'SOLA 变速', color: 'text-sky-300 bg-sky-500/10' },
  'gap-borrow': { label: '借间隙', color: 'text-indigo-300 bg-indigo-500/10' },
  'video-slow': { label: '视频慢放', color: 'text-amber-300 bg-amber-500/10' },
  overflow: { label: '溢出', color: 'text-rose-300 bg-rose-500/10' },
}

const FLAG_COLOR: Record<string, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-400',
  red: 'bg-rose-500',
}

interface Props {
  projectId: ProjectId
  /** 用作刷新触发器：父组件在 align stage 完成后递增此值 */
  refreshKey?: number
}

/**
 * 对齐决策面板（PRD FR-ALIGN-03）：
 *
 *   - 上方汇总：5 种策略各多少句、平均偏差、红/黄/绿数量
 *   - 下方列表：每句一行，显示原时长 / TTS 时长 / 偏差 / 策略 / flag
 */
export function AlignPanel({ projectId, refreshKey }: Props): JSX.Element {
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void api
      .call('segment:list', { projectId })
      .then((list) => setSegments(list))
      .finally(() => setLoading(false))
  }, [projectId, refreshKey])

  const aligned = segments.filter((s) => s.align != null)
  if (loading) {
    return <div className="p-6 text-sm text-zinc-500">加载对齐数据…</div>
  }
  if (aligned.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-500">
        还没有对齐数据——跑到 align 阶段后这里会显示每句的对齐策略。
      </div>
    )
  }

  // 汇总
  const summary: Record<string, number> = {}
  const flagCount = { green: 0, yellow: 0, red: 0 }
  let totalAbsOffset = 0
  for (const s of aligned) {
    if (!s.align) continue
    summary[s.align.strategy] = (summary[s.align.strategy] ?? 0) + 1
    if (s.align.flag) flagCount[s.align.flag]++
    totalAbsOffset += Math.abs(s.align.offsetMs)
  }
  const avgAbsOffset = Math.round(totalAbsOffset / aligned.length)

  return (
    <div className="flex flex-col gap-4 p-6 overflow-auto h-full">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-semibold">对齐汇总</h2>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
          {Object.entries(STRATEGY_LABEL).map(([k, v]) => {
            const n = summary[k] ?? 0
            if (n === 0) return null
            return (
              <span key={k} className={`rounded px-2 py-1 ${v.color}`}>
                {v.label} · {n}
              </span>
            )
          })}
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${FLAG_COLOR.green}`} />
            绿 {flagCount.green}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${FLAG_COLOR.yellow}`} />
            黄 {flagCount.yellow}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${FLAG_COLOR.red}`} />
            红 {flagCount.red}
          </span>
          <span className="ml-auto">平均绝对偏差 {avgAbsOffset}ms</span>
        </div>
      </header>

      <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/40">
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">原文 → 译文</th>
              <th className="px-3 py-2 text-right">原时长</th>
              <th className="px-3 py-2 text-right">TTS 时长</th>
              <th className="px-3 py-2 text-right">偏差</th>
              <th className="px-3 py-2 text-left">策略</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {aligned.map((s) => {
              const strategy = s.align!.strategy
              const sl = STRATEGY_LABEL[strategy] ?? { label: strategy, color: '' }
              const flag = s.align!.flag ?? 'green'
              return (
                <tr key={s.id} className="border-t border-zinc-800/50">
                  <td className="px-3 py-2 text-zinc-500">{s.idx + 1}</td>
                  <td className="px-3 py-2">
                    <div className="text-zinc-400">{s.srcText}</div>
                    <div className="text-zinc-200">{s.tgtTextEdited ?? s.tgtText}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                    {(s.endMs - s.startMs)}ms
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                    {s.tgtDurMs ?? '—'}
                    {typeof s.tgtDurMs === 'number' ? 'ms' : ''}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      Math.abs(s.align!.offsetMs) < 100
                        ? 'text-zinc-500'
                        : Math.abs(s.align!.offsetMs) < 300
                          ? 'text-amber-400'
                          : 'text-rose-400'
                    }`}
                  >
                    {s.align!.offsetMs >= 0 ? '+' : ''}
                    {s.align!.offsetMs}ms
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 ${sl.color}`}>{sl.label}</span>
                    {s.align!.appliedSolaRatio && (
                      <span className="ml-2 text-zinc-500">
                        ×{s.align!.appliedSolaRatio.toFixed(3)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${FLAG_COLOR[flag]}`} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
