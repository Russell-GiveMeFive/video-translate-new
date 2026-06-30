import type { PipelineStatus } from '@dramaprime/core-types'
import { api } from '../api/index.js'

const STAGE_OUTPUT_LABEL: Record<string, { stage: string; label: string }> = {
  // 标准 outputs 名 → 中文标签 + 所属 stage
  metadata: { stage: 'preprocess', label: '视频元数据' },
  thumbs: { stage: 'preprocess', label: '缩略图' },
  ass: { stage: 'subtitle-burn', label: '字幕 ASS' },
  srt: { stage: 'subtitle-burn', label: '字幕 SRT' },
  render: { stage: 'mix-render', label: '译制后视频' },
  audio: { stage: 'asr-diarize', label: '人声音轨' },
}

interface Props {
  status: PipelineStatus | null
}

/**
 * 产物面板：从 pipeline status 里聚合 stage outputs 路径，让用户能：
 *   - 在 Finder/Explorer 里打开产物所在文件夹
 *   - 一目了然看到目前已经生成哪些产物
 */
export function ArtifactsPanel({ status }: Props): JSX.Element | null {
  if (!status) return null

  // 收集所有 stage 的 outputs（{path: string}）
  const items: Array<{ key: string; label: string; path: string; stage: string }> = []
  for (const stage of status.stages) {
    if (stage.status !== 'done') continue
    for (const [k, v] of Object.entries(stage.outputs)) {
      const meta = STAGE_OUTPUT_LABEL[k]
      if (!meta) continue
      // 仅展示已注册的"可打开"产物（路径形态）
      if (typeof v !== 'string' || !v.includes('/')) continue
      items.push({ key: k, label: meta.label, path: v, stage: stage.stage })
    }
  }

  if (items.length === 0) {
    return (
      <div className="mt-8 rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
        还没有产物——跑完几个 stage 后这里会列出来。
      </div>
    )
  }

  const openInExplorer = (path: string): void => {
    void api.call('system:open-in-explorer', path)
  }

  return (
    <div className="mt-8">
      <h3 className="mb-3 text-sm font-semibold">产物</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li
            key={`${it.stage}:${it.key}`}
            className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="text-zinc-300">{it.label}</div>
              <div className="truncate text-[10px] text-zinc-500" title={it.path}>
                {it.path}
              </div>
            </div>
            <button
              onClick={() => openInExplorer(it.path)}
              className="rounded border border-zinc-700 px-2 py-1 text-[10px] hover:bg-zinc-800"
              title="在 Finder/Explorer 打开"
            >
              打开
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
