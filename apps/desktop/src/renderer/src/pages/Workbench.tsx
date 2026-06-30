import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/index.js'
import { useAppStore } from '../stores/app.js'
import {
  ALL_STAGES,
  LANG_MAP,
  type PipelineStatus,
  type ProjectDetail,
  type StageName,
} from '@dramaprime/core-types'
import { AlignPanel } from '../components/AlignPanel.js'
import { ArtifactsPanel } from '../components/ArtifactsPanel.js'
import { Workstation } from '../components/Workstation.js'
import { toast } from '../components/Toast.js'  // v0.4.12 全局 toast

const STAGE_LABEL: Record<StageName, string> = {
  preprocess: '预处理',
  'import-precheck': '准入检查',
  'shot-detect': '镜头切分',
  demix: '人声分离',
  'asr-diarize': 'ASR + 分轨',
  'ocr-assist': 'OCR 辅助',
  cluster: '角色聚类',
  'voice-clone': '音色复刻',
  translate: 'LLM 翻译',
  'tts-synth': 'TTS 合成',
  align: '时长对齐',
  'subtitle-burn': '字幕烧录',
  'mix-render': '视频合成',
  finalize: '收尾',
}

export function Workbench(): JSX.Element {
  const currentId = useAppStore((s) => s.currentProjectId)
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [progress, setProgress] = useState<{ stage: StageName; percent: number; message?: string } | null>(null)
  const [costCents, setCostCents] = useState(0)
  const [tab, setTab] = useState<'overview' | 'workstation' | 'align'>('overview')
  const [alignRefreshKey, setAlignRefreshKey] = useState(0)
  /** stage 失败时显示完整错误（最新的覆盖旧的；点 ▶ 开始时清空） */
  const [latestError, setLatestError] = useState<{
    stage: StageName
    code: string
    message: string
    retriable: boolean
    context?: Record<string, unknown>
  } | null>(null)

  useEffect(() => {
    if (!currentId) return
    setLatestError(null)
    void api.call('project:get', currentId).then(setProject)
    void api.call('pipeline:status', { projectId: currentId }).then((s) => {
      setStatus(s)
      // ★ v0.4.11 修复"返回-重入进度停滞"：
      // remount 后 progress state 是 null，但 status.currentStage 还在跑着
      // 拿 status.currentStage 反推一个初始 progress（percent=0、message 显示"运行中"）
      if (s.status === 'running' && s.currentStage) {
        setProgress({
          stage: s.currentStage as StageName,
          percent: 0,
          message: '运行中',
        })
      }
    })
  }, [currentId])

  // ★ v0.4.11 兜底轮询：每 3 秒拉一次 pipeline:status
  // 解决 IPC event 漏接 / 重 mount 后订阅未及时建立的边缘 case
  useEffect(() => {
    if (!currentId) return
    const id = window.setInterval(() => {
      void api.call('pipeline:status', { projectId: currentId }).then((s) => {
        setStatus(s)
        // 如果主进程报 status='running' 但 progress state 是空 → 重建假进度
        if (s.status === 'running' && s.currentStage) {
          const cs = s.currentStage
          setProgress((p) =>
            p && p.stage === cs ? p : { stage: cs, percent: 0, message: '运行中' },
          )
        } else if (s.status !== 'running') {
          // pipeline 已结束 → 清掉 progress 高亮
          setProgress(null)
        }
      })
    }, 3000)
    return () => window.clearInterval(id)
  }, [currentId])

  // 订阅进度推送
  useEffect(() => {
    const offProgress = window.api.on('event:pipeline:progress', (p) => {
      if (p.projectId !== currentId) return
      setProgress({ stage: p.stage, percent: p.percent, message: p.message })
    })
    const offDone = window.api.on('event:pipeline:stage-done', (p) => {
      if (p.projectId !== currentId) return
      void api.call('pipeline:status', { projectId: currentId! }).then(setStatus)
      if (p.stage === 'align' || p.stage === 'tts-synth' || p.stage === 'translate') {
        setAlignRefreshKey((n) => n + 1)
      }
    })
    const offError = window.api.on('event:pipeline:error', (p) => {
      if (p.projectId !== currentId) return
      setLatestError({
        stage: p.stage,
        code: p.error.code,
        message: p.error.message,
        retriable: p.error.retriable,
        context: p.error.context,
      })
      // ★ v0.4.12 全局 toast：阶段失败推送（即使用户切走页面也看得到）
      // 限流类错误不刷屏（同一个 stage 一次提示）
      const codeStr = p.error.code ?? 'unknown'
      const isRateLimit = codeStr === 'provider.rate-limited'
      toast.error(
        `${STAGE_LABEL[p.stage as StageName] ?? p.stage} 失败`,
        `${codeStr}${p.error.message ? `\n${p.error.message.slice(0, 200)}` : ''}`,
      )
    })
    const offFinished = window.api.on('event:pipeline:finished', (p) => {
      if (p.projectId !== currentId) return
      setCostCents(p.totalCostCents)
      void api.call('pipeline:status', { projectId: currentId! }).then(setStatus)
      setProgress(null)
      // ★ v0.4.12 全局 toast：pipeline 完成推送
      const isSuccess = p.status === 'done'
      const cost = (p.totalCostCents / 100).toFixed(2)
      const msg = isSuccess
        ? `全部阶段已完成，累计 ¥${cost}`
        : `pipeline 已中断（status=${p.status}），累计 ¥${cost}`
      if (isSuccess) toast.success('译制完成', msg)
      else toast.warn('pipeline 终止', msg)
    })
    return () => {
      offProgress()
      offDone()
      offError()
      offFinished()
    }
  }, [currentId])

  const stageStateMap = useMemo(() => {
    const map: Record<StageName, string> = Object.fromEntries(
      ALL_STAGES.map((s) => [s, 'pending']),
    ) as Record<StageName, string>
    if (status) for (const s of status.stages) map[s.stage] = s.status
    return map
  }, [status])

  if (!currentId)
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        从「项目」中选一个开始译制
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-8 pt-5">
        <h1 className="text-lg font-semibold">{project?.name ?? '加载中…'}</h1>
        <div className="mt-1 text-xs text-zinc-500">
          目标：{project ? LANG_MAP[project.targetLang]?.zhName ?? project.targetLang : '—'}  ·  状态：{status?.status ?? '—'}  ·  累计：¥
          {(status?.costTotalCents ?? costCents) / 100}
        </div>
        {/* Tab 切换 */}
        <div className="mt-4 flex gap-4 border-b border-zinc-800 -mb-px">
          <button
            onClick={() => setTab('overview')}
            className={`pb-2 text-xs ${
              tab === 'overview'
                ? 'border-b-2 border-indigo-400 text-indigo-300'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            概览
          </button>
          <button
            onClick={() => setTab('workstation')}
            className={`pb-2 text-xs ${
              tab === 'workstation'
                ? 'border-b-2 border-indigo-400 text-indigo-300'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            工作台
          </button>
          <button
            onClick={() => setTab('align')}
            className={`pb-2 text-xs ${
              tab === 'align'
                ? 'border-b-2 border-indigo-400 text-indigo-300'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            对齐
          </button>
        </div>
      </header>

      {tab === 'workstation' ? (
        <Workstation projectId={currentId} refreshKey={alignRefreshKey} />
      ) : tab === 'align' ? (
        <AlignPanel projectId={currentId} refreshKey={alignRefreshKey} />
      ) : (
        <div className="flex flex-1 overflow-hidden">
        <section className="flex w-2/3 flex-col gap-4 overflow-auto p-8">
          {/* 错误 banner：stage 失败时显示完整错误，可点重试 */}
          {latestError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span className="rounded bg-rose-500/30 px-2 py-0.5 font-semibold text-rose-200">
                  {latestError.stage} 失败
                </span>
                <span className="text-rose-300">{latestError.code}</span>
                {latestError.retriable && (
                  <span className="rounded border border-amber-500/40 px-1.5 text-amber-300">
                    可重试
                  </span>
                )}
              </div>
              <div className="mb-2 whitespace-pre-wrap break-words text-rose-100">
                {latestError.message}
              </div>
              {latestError.context && Object.keys(latestError.context).length > 0 && (
                <details className="mb-2">
                  <summary className="cursor-pointer text-rose-300">详细 context</summary>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/40 p-2 text-[10px] text-rose-200">
                    {JSON.stringify(latestError.context, null, 2)}
                  </pre>
                </details>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setLatestError(null)
                    void api.call('pipeline:retry-stage', {
                      projectId: currentId,
                      stage: latestError.stage,
                    })
                  }}
                  className="rounded-md bg-rose-500 px-3 py-1 text-[11px] hover:bg-rose-400"
                >
                  ↻ 重试此 stage
                </button>
                <button
                  onClick={() => setLatestError(null)}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-[11px] hover:bg-zinc-800"
                >
                  关闭
                </button>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">译制流水线</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setLatestError(null)
                    void api.call('pipeline:start', { projectId: currentId })
                  }}
                  className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs hover:bg-indigo-400"
                >
                  ▶ 开始
                </button>
                <button
                  onClick={() => api.call('pipeline:pause', { projectId: currentId })}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
                >
                  ⏸ 暂停
                </button>
                <button
                  onClick={() => {
                    if (
                      !confirm(
                        '全部重跑会清掉本项目的所有阶段记录、角色、克隆音色、合成音频与渲染视频，从头跑一遍。源视频文件不变。\n\n继续吗？',
                      )
                    )
                      return
                    setLatestError(null)
                    setProgress(null)
                    void api
                      .call('pipeline:reset-all', { projectId: currentId })
                      .then(() => api.call('pipeline:status', { projectId: currentId }))
                      .then(setStatus)
                  }}
                  className="rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20"
                  title="清空所有阶段产物并从头重跑（源视频不变）"
                >
                  ↻ 全部重跑
                </button>
              </div>
            </div>
            <ol className="space-y-2">
              {ALL_STAGES.map((s) => {
                const st = stageStateMap[s]
                const isActive = progress?.stage === s
                const stageRec = status?.stages.find((x) => x.stage === s)
                const errMsg = stageRec?.error
                const canRetryHere = st === 'done' || st === 'failed'
                return (
                  <li
                    key={s}
                    className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-sm transition ${
                      st === 'done'
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : st === 'failed'
                          ? 'border-rose-500/30 bg-rose-500/5'
                          : isActive
                            ? 'border-indigo-500/50 bg-indigo-500/10'
                            : 'border-zinc-800 bg-zinc-900/30'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-5 text-center">
                        {st === 'done' ? '✓' : st === 'failed' ? '✗' : isActive ? '◆' : '○'}
                      </span>
                      <span className="flex-1">{STAGE_LABEL[s]}</span>
                      {isActive && (
                        <span className="text-xs text-indigo-300">
                          {progress?.percent}% {progress?.message ? `· ${progress.message}` : ''}
                        </span>
                      )}
                      <span className="text-[10px] uppercase text-zinc-500">{st}</span>
                      {canRetryHere && !isActive && (
                        <button
                          onClick={() => {
                            if (
                              !confirm(
                                `从「${STAGE_LABEL[s]}」开始重跑——它和后面的所有阶段产物都会被清掉重新生成。\n\n继续吗？`,
                              )
                            )
                              return
                            setLatestError(null)
                            void api
                              .call('pipeline:retry-stage', {
                                projectId: currentId,
                                stage: s,
                              })
                              .then(() => api.call('pipeline:status', { projectId: currentId }))
                              .then(setStatus)
                          }}
                          className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-amber-500/40 hover:text-amber-300"
                          title="从这一步开始重跑（含所有下游阶段）"
                        >
                          ↻ 重跑
                        </button>
                      )}
                    </div>
                    {st === 'failed' && errMsg && (
                      <div className="ml-8 text-[11px] text-rose-300">
                        {errMsg}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
        </section>

        <aside className="w-1/3 border-l border-zinc-800 overflow-auto p-8">
          <h2 className="mb-3 text-sm font-semibold">项目信息</h2>
          <dl className="space-y-2 text-xs text-zinc-400">
            <div>
              <dt className="text-zinc-500">源视频</dt>
              <dd className="break-all text-zinc-200">{project?.sourcePath}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">渲染预设</dt>
              <dd>{project?.config.renderPreset}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">LLM 模型</dt>
              <dd>{project?.config.llm.model}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">TTS 模型</dt>
              <dd>{project?.config.tts.model}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">视频局部慢放</dt>
              <dd>
                {project?.config.align.enableVideoSlow ? '✓ 开启' : '✗ 关闭'} (±
                {((project?.config.align.videoSlowMaxRatio ?? 0) * 100).toFixed(0)}%)
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">字幕</dt>
              <dd>
                {project?.config.subtitle.burnIn ? '✓ 烧入画面' : '○ 不烧入'}
                {' · '}
                {project?.config.subtitle.bilingual ? '双语 中-英' : '单语'}
              </dd>
            </div>
          </dl>

          <ArtifactsPanel status={status} />
        </aside>
      </div>
      )}
    </div>
  )
}
