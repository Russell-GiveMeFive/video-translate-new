# 短剧 AI 译制桌面客户端 TDD（技术方案文档）

> **版本**：v0.1 + v0.4.13 状态补充
> **日期**：2026-06-07（2026-06-15 补充）
> **状态**：草稿；与 PRD v0.3（D1-D13 决议）对齐
> **配套文档**：[PRD.md](./PRD.md) · [WORKFLOW.md](./WORKFLOW.md) · [TECHNICAL-GUIDE.md](./TECHNICAL-GUIDE.md)

> ## v0.4.13 状态补充（2026-06-15）
>
> 本文档主体（v0.1 草稿）保持原样。下方为 v0.4.13 实际实现差异：
>
> **Stage 实现变化**：
> - **ocr-assist stage**（v0.4.8 上线）：MiniMax M3 Vision 识别原片中文字幕时间轴，1.5fps+并发4+60s超时
> - **tts-synth stage**（v0.4.9-v0.4.12 多次重写）：包含短句嘶吼检测、emotion 白名单校验（不含 neutral）、loudnorm 归一化、限流重试
> - **asr-diarize stage**（v0.4.10）：新增 startMs<0 脏数据过滤（卡拉 OK 词级时间戳）
>
> **新增模块**：
> - `apps/desktop/src/main/storage/voice-asset-repo.ts`（v0.4.12）
> - `apps/desktop/src/main/ipc/voice.ts`（v0.4.12 完整实现）
> - `apps/desktop/src/renderer/src/components/Toast.tsx`（v0.4.12）
> - `apps/desktop/src/renderer/src/pages/Voices.tsx`（v0.4.12 真实组件）
> - `build.sh` 一键打包脚本（v0.4.12）
>
> **Schema 变更**：
> - `segments` 表加 `thumb_path` 列（v0.4.11，关联到 thumb-extract stage）
> - `voice_assets` 表早就 schema 里、v0.4.12 才实现 repo + IPC
> - 详见 [WORKFLOW.md](./WORKFLOW.md) §6 关键文件路径

---

## 0. 文档导航

1. [总体架构](#1-总体架构)
2. [Monorepo 结构与构建](#2-monorepo-结构与构建)
3. [进程模型与生命周期](#3-进程模型与生命周期)
4. [IPC 协议与 contextBridge](#4-ipc-协议与-contextbridge)
5. [Python Sidecar JSON-RPC 协议](#5-python-sidecar-json-rpc-协议)
6. [Pipeline 状态机与 Stage 抽象](#6-pipeline-状态机与-stage-抽象)
7. [Provider 抽象层](#7-provider-抽象层)
8. [MiniMax Client 详细设计](#8-MiniMax-client-详细设计)
9. [火山豆包 ASR Client 详细设计](#9-火山豆包-asr-client-详细设计)
10. [时长对齐算法实现](#10-时长对齐算法实现)
11. [存储层：SQLite 完整 DDL](#11-存储层sqlite-完整-ddl)
12. [文件系统与缓存布局](#12-文件系统与缓存布局)
13. [密钥管理与安全](#13-密钥管理与安全)
14. [错误模型与重试策略](#14-错误模型与重试策略)
15. [可观测性：日志 / 进度 / 成本](#15-可观测性日志--进度--成本)
16. [打包、签名、自动更新](#16-打包签名自动更新)
17. [测试策略](#17-测试策略)
18. [技术决策记录与新决策点](#18-技术决策记录与新决策点)

---

## 1. 总体架构

### 1.1 进程拓扑

```
┌────────────────────────────────────────────────────────────────┐
│                    Electron Main Process (Node 20)              │
│  - 单例 (single-instance lock)                                   │
│  - 应用生命周期 / 菜单 / 托盘 / 自动更新                          │
│  - 项目管理 / SQLite                                              │
│  - Pipeline Orchestrator (调度 14 个 Stage)                      │
│  - Keystore (keytar)                                             │
│  - 启动 / 监控 Sidecar 与 utilityProcess                          │
└────────────────────────────────────────────────────────────────┘
        │ contextBridge IPC          │ fork                │ spawn
        ▼                             ▼                     ▼
┌──────────────────┐  ┌───────────────────────┐  ┌─────────────────────┐
│ Renderer Process │  │  utilityProcess (N)   │  │  Python Sidecar     │
│ (Chromium + V8)  │  │  - ffmpeg encode      │  │  (子进程, stdio JSON│
│ - React 18 + Vite│  │  - 大文件上传/下载    │  │   -RPC)              │
│ - Zustand        │  │  - 长任务计算 (CPU)   │  │  - Demucs            │
│ - shadcn/ui      │  │  独立 V8 实例，崩溃    │  │  - PaddleOCR         │
│ - 仅经 preload   │  │  不影响 Main          │  │  - pyannote diarize  │
│   白名单调用 Main │  │                       │  │  - ECAPA embedding   │
└──────────────────┘  └───────────────────────┘  └─────────────────────┘
                                                          │
                                                          ▼
                                                  ┌────────────────┐
                                                  │ 静态二进制      │
                                                  │ - ffmpeg        │
                                                  │ - ffprobe       │
                                                  └────────────────┘
```

### 1.2 关键设计原则（写入工程红线）

| # | 原则 | 落地约束 |
| :-: | :-- | :-- |
| 1 | **大文件不进 IPC** | 视频 / 音频通过文件路径引用；Renderer 用 `file://` + `--allow-file-access-from-files` 替代品 `app://` 协议读取；二进制数据禁止 JSON 序列化跨进程 |
| 2 | **重活进 utilityProcess** | ffmpeg / 大上传 / Demucs / inpaint 等阻塞操作必须走 `utilityProcess.fork`，Main 进程只做调度 |
| 3 | **Renderer 严格沙箱** | `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`；IPC 通道经 preload 白名单暴露 |
| 4 | **每个 Stage 幂等可重跑** | Stage 接受 `ctx`，输出写到 stage 专属目录；重跑前清空目录；checkpoint 写 SQLite |
| 5 | **外部调用一律可重试** | 每个 Provider 调用走统一重试中间件（指数退避 + jitter + budget） |
| 6 | **配置热加载** | 模型版本 / prompt 规则库 / 术语表用 YAML，可不重启应用刷新 |
| 7 | **退出时清理子进程** | Main 监听 `before-quit`，向所有 utilityProcess / sidecar 发优雅退出信号；5s 超时则 SIGKILL |
| 8 | **路径可移植** | 所有路径用 `path.join`；项目工程包内存相对路径，对绝对路径做 portability 处理 |

### 1.3 技术栈版本锁

| 类别 | 选型 | 锁定原因 |
| :-- | :-- | :-- |
| Electron | 30.x | utilityProcess 稳定、Node 20 LTS |
| Node | 20.x（随 Electron） | LTS、`undici` 内建 |
| TypeScript | 5.4+ | satisfies / const generics |
| React | 18.3+ | concurrent + Suspense |
| Vite | 5.x | electron-vite 模板 |
| Tailwind | 3.4+ | shadcn/ui 依赖 |
| shadcn/ui | latest | 不锁版本，按需引入组件 |
| Zustand | 4.x | 简单可靠 |
| better-sqlite3 | 11.x | 同步 API，事务清晰 |
| keytar | 7.x | Keychain / DPAPI / libsecret |
| undici | 6.x | Node 20 内置 |
| ws | 8.x | WebSocket，火山 ASR 流式 |
| Python | 3.11 | PyInstaller 兼容性最佳 |
| ffmpeg | 6.x（静态编译） | libass、libx264/265、libfdk_aac、librubberband |

---

## 2. Monorepo 结构与构建

### 2.1 目录结构

```
dramaprime/
├── package.json                 # workspaces 根
├── pnpm-workspace.yaml          # 用 pnpm（节省磁盘）
├── electron-builder.yml         # 打包配置
├── tsconfig.base.json
├── apps/
│   └── desktop/                 # Electron 应用
│       ├── package.json
│       ├── electron.vite.config.ts
│       ├── src/
│       │   ├── main/            # Main 进程
│       │   │   ├── index.ts     # 入口
│       │   │   ├── window.ts
│       │   │   ├── menu.ts
│       │   │   ├── ipc/         # IPC handlers (按域分文件)
│       │   │   │   ├── project.ts
│       │   │   │   ├── pipeline.ts
│       │   │   │   ├── keystore.ts
│       │   │   │   └── ...
│       │   │   ├── orchestrator/  # Pipeline 调度
│       │   │   ├── stages/        # 14 个 stage 实现
│       │   │   ├── providers/     # MiniMax / volcengine 客户端
│       │   │   ├── sidecar/       # Python sidecar 启动 / RPC
│       │   │   ├── workers/       # utilityProcess 入口
│       │   │   ├── storage/       # better-sqlite3 仓库
│       │   │   ├── keystore/      # keytar 封装
│       │   │   ├── updater/       # electron-updater
│       │   │   └── logger.ts
│       │   ├── preload/
│       │   │   └── index.ts     # contextBridge 白名单
│       │   └── renderer/        # React UI
│       │       ├── index.html
│       │       ├── main.tsx
│       │       ├── App.tsx
│       │       ├── routes/
│       │       ├── pages/
│       │       │   ├── ProjectList.tsx
│       │       │   ├── Workbench.tsx       # 项目工作台
│       │       │   ├── SegmentEditor.tsx   # 句级编辑器
│       │       │   ├── BatchQueue.tsx
│       │       │   ├── VoiceLibrary.tsx
│       │       │   └── Settings.tsx
│       │       ├── components/
│       │       ├── stores/      # Zustand
│       │       ├── hooks/
│       │       ├── api/         # window.api.xxx 包装
│       │       └── i18n/        # 简中 + EN
├── packages/
│   ├── core-types/              # 共享 TS 类型（全 monorepo 引用）
│   ├── provider-MiniMax/        # MiniMax HTTP/WS 封装
│   ├── provider-volcengine/     # 火山豆包封装
│   ├── pipeline-core/           # Stage 抽象 + 状态机
│   ├── align-engine/            # 时长对齐算法
│   └── i18n-resources/          # 多语种 prompt 规则库 + 字体清单
├── sidecar/
│   ├── pyproject.toml
│   ├── dramaprime_sidecar/
│   │   ├── __main__.py          # JSON-RPC over stdio
│   │   ├── rpc.py               # 协议
│   │   ├── handlers/
│   │   │   ├── demucs.py
│   │   │   ├── ocr.py           # PaddleOCR
│   │   │   ├── diarize.py       # pyannote
│   │   │   ├── embed.py         # ECAPA
│   │   │   └── shot_detect.py   # PySceneDetect
│   │   └── models/              # 运行时下载到 ~/.dramaprime/models
│   └── build/
│       └── build.py             # PyInstaller --onedir 入口
├── binaries/                    # 随包二进制（按 OS/Arch 分目录）
│   ├── ffmpeg/
│   │   ├── darwin-arm64/ffmpeg
│   │   ├── darwin-x64/ffmpeg
│   │   └── win32-x64/ffmpeg.exe
│   └── sidecar/                 # PyInstaller 产物（构建时复制进来）
└── docs/
    ├── PRD.md
    ├── TDD.md
    └── adr/                     # 架构决策记录
```

### 2.2 构建流程

```
开发：
  pnpm install
  pnpm --filter desktop dev       # electron-vite dev，HMR 完整
  pnpm --filter sidecar dev       # sidecar 本地 Python 跑

构建：
  pnpm build:sidecar              # PyInstaller --onedir → binaries/sidecar/<os-arch>
  pnpm build:desktop              # electron-vite build → apps/desktop/out
  pnpm dist                       # electron-builder → dmg / msi / exe
```

`electron-vite` 自动产出 `out/main/`、`out/preload/`、`out/renderer/`，`electron-builder` 把这些 + `binaries/` + `node_modules` 打 asar。

### 2.3 跨平台目标

| 目标 | electron-builder target | 产物 |
| :-- | :-- | :-- |
| macOS Apple Silicon | dmg, target: dmg, arch: arm64 | DramaPrime-{ver}-arm64.dmg |
| macOS Intel | dmg, target: dmg, arch: x64 | DramaPrime-{ver}-x64.dmg |
| macOS Universal（合并） | dmg, target: dmg, arch: universal | DramaPrime-{ver}-universal.dmg（一选） |
| Windows x64 | nsis + portable | DramaPrime-Setup-{ver}.exe + DramaPrime-{ver}-portable.exe |
| Windows arm64（v1.1+ 评估） | nsis, arch: arm64 | DramaPrime-Setup-{ver}-arm64.exe |

> ❓ **新决策点 T1**：Mac 只发 Universal 包（大，省维护）还是分 arm64 / x64 双包（小，多维护）？

---

## 3. 进程模型与生命周期

### 3.1 进程角色

| 进程 | 数量 | 职责 | 崩溃影响 |
| :-- | :-: | :-- | :-- |
| Main | 1 | 应用生命周期、IPC 总线、Orchestrator | 整个应用退出 |
| Renderer | 1（v1.0 单窗口） | UI | 弹窗提示，可恢复 |
| utilityProcess: ffmpeg | 0..N | 视频/音频转码、混音、合成 | 任务失败，可重试 |
| utilityProcess: uploader | 0..M | 大文件上传 / 下载 | 任务失败，可重试 |
| Python Sidecar | 1（长驻） | Demucs / OCR / Diarize / Embed / SceneDetect | 任务失败 + 自动重启 |

> **为什么 sidecar 长驻而不是每次 fork**：Python 解释器冷启动 + 模型加载（Demucs ~3s、PaddleOCR ~2s）每次都做太慢；长驻进程模型常驻内存，单次任务 0.5s 内启动。代价是内存占用 +400MB 左右，可接受。

### 3.2 启动顺序

```
1. Electron app.whenReady
2. 单例锁 (app.requestSingleInstanceLock)；非首实例聚焦已有窗口后退出
3. 初始化 logger（pino, 文件 + 控制台）
4. 初始化 SQLite（better-sqlite3 + migrations）
5. 初始化 Keystore（keytar）
6. 启动 Python Sidecar（asyncio init handshake，超时 10s）
7. 创建 BrowserWindow（preload 路径绝对）
8. 注册 IPC handlers
9. 启动自动更新检查（延迟 30s，避免冷启动阻塞）
10. Renderer 完成 mount → Renderer 通过 IPC 请求 "system:ready" 并获取项目列表
```

### 3.3 退出流程

```
1. before-quit 事件触发
2. Orchestrator.pauseAll()  → 所有运行中 Stage 收到取消信号
3. Sidecar.shutdown()         → 发送 RPC notification "shutdown"，等待 ACK 最多 3s
4. utilityProcess.kill('SIGTERM') 全部子进程；3s 超时 → SIGKILL
5. SQLite.close()
6. app.quit() 完成
```

> 关键：用户在 Pipeline 运行中关窗口 → 弹确认对话框「正在译制中，关闭将暂停任务」，确认后走上面流程。

---

## 4. IPC 协议与 contextBridge

### 4.1 通道命名规范

`<domain>:<action>`，例如：

- `project:create` / `project:list` / `project:open` / `project:delete`
- `pipeline:start` / `pipeline:pause` / `pipeline:retry` / `pipeline:status`
- `keystore:get` / `keystore:set` / `keystore:test`
- `segment:update` / `segment:tts:regenerate`
- `voice:list` / `voice:clone` / `voice:promote`
- `system:ready` / `system:select-file` / `system:open-in-explorer`

事件（Main → Renderer，单向推送）：

- `event:pipeline:progress` — { projectId, stage, percent, eta, costDeltaCents }
- `event:pipeline:stage-done` — { projectId, stage, outputs }
- `event:pipeline:error` — { projectId, stage, error }
- `event:voice:expiring` — { voiceId, expireAt }
- `event:provider:health` — { provider, healthy, latencyMs }

### 4.2 preload 白名单

```ts
// apps/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type { ApiSurface, EventName, EventPayload } from '@dramaprime/core-types'

const invoke = <K extends keyof ApiSurface>(
  channel: K,
  payload?: Parameters<ApiSurface[K]>[0]
): ReturnType<ApiSurface[K]> => ipcRenderer.invoke(channel, payload) as any

const on = <K extends EventName>(
  channel: K,
  listener: (payload: EventPayload<K>) => void
): (() => void) => {
  const wrapped = (_: IpcRendererEvent, p: EventPayload<K>) => listener(p)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('api', {
  invoke,
  on,
})
```

Renderer 侧严格通过 `window.api.invoke(...)` 调用，所有可调用通道收敛在 `ApiSurface` 类型，任何新增 IPC 必须先改类型再实现，编译期约束齐全。

### 4.3 类型契约（核心片段）

```ts
// packages/core-types/src/api.ts
export type ApiSurface = {
  // ---- system ----
  'system:ready': () => Promise<{ version: string; platform: string; locale: string }>
  'system:select-file': (opts: { kind: 'video' | 'audio' | 'srt'; multi?: boolean })
    => Promise<string[]>          // 返回绝对路径数组
  'system:open-in-explorer': (path: string) => Promise<void>
  'system:reveal-logs': () => Promise<void>

  // ---- keystore ----
  'keystore:get': (key: KeyName) => Promise<string | null>
  'keystore:set': (input: { key: KeyName; value: string }) => Promise<void>
  'keystore:test': (provider: ProviderName) => Promise<{ ok: boolean; balanceCents?: number; error?: string }>

  // ---- project ----
  'project:create': (input: CreateProjectInput) => Promise<ProjectId>
  'project:list': (filter?: ProjectFilter) => Promise<ProjectSummary[]>
  'project:get': (id: ProjectId) => Promise<ProjectDetail>
  'project:delete': (id: ProjectId) => Promise<void>
  'project:duplicate': (id: ProjectId) => Promise<ProjectId>
  'project:import': (path: string) => Promise<ProjectId>          // 导入 .dpx
  'project:export': (id: ProjectId, output: string) => Promise<void>

  // ---- pipeline ----
  'pipeline:start': (input: { projectId: ProjectId; resumeFrom?: StageName })
    => Promise<{ runId: string }>
  'pipeline:pause': (input: { projectId: ProjectId }) => Promise<void>
  'pipeline:retry-stage': (input: { projectId: ProjectId; stage: StageName }) => Promise<void>
  'pipeline:status': (input: { projectId: ProjectId }) => Promise<PipelineStatus>

  // ---- segment / character ----
  'segment:list': (input: { projectId: ProjectId }) => Promise<Segment[]>
  'segment:update': (input: SegmentPatch) => Promise<void>
  'segment:tts:regenerate': (input: { projectId: ProjectId; segmentId: string; reason?: string })
    => Promise<{ taskId: string }>
  'character:list': (input: { projectId: ProjectId }) => Promise<Character[]>
  'character:rename': (input: { projectId: ProjectId; characterId: string; name: string }) => Promise<void>
  'character:reclone': (input: { projectId: ProjectId; characterId: string; segmentIds?: string[] }) => Promise<void>

  // ---- voice library ----
  'voice:list': () => Promise<VoiceAsset[]>
  'voice:promote': (input: { voiceId: string; name: string; tags?: string[] }) => Promise<void>
  'voice:delete': (input: { voiceId: string }) => Promise<void>

  // ---- batch ----
  'batch:enqueue': (input: BatchEnqueueInput) => Promise<{ batchId: string }>
  'batch:status': (input: { batchId?: string }) => Promise<BatchStatus[]>
  'batch:cancel': (input: { batchId: string }) => Promise<void>
}
```

### 4.4 IPC 安全 / 错误处理

每个 invoke handler 走统一包装器：

```ts
// main/ipc/wrap.ts
export function handleIpc<K extends keyof ApiSurface>(
  channel: K,
  handler: (payload: Parameters<ApiSurface[K]>[0]) => Promise<Awaited<ReturnType<ApiSurface[K]>>>
) {
  ipcMain.handle(channel, async (_evt, payload) => {
    const t0 = Date.now()
    try {
      const result = await handler(payload)
      logger.debug({ channel, ms: Date.now() - t0 }, 'ipc.ok')
      return { ok: true, data: result }
    } catch (err) {
      const e = normalizeError(err)
      logger.warn({ channel, code: e.code, ms: Date.now() - t0 }, 'ipc.err')
      return { ok: false, error: { code: e.code, message: e.message, retriable: e.retriable } }
    }
  })
}
```

Renderer 侧的 `window.api.invoke` 拿到的总是 `{ ok, data?, error? }`，强制处理错误分支。

---

## 5. Python Sidecar JSON-RPC 协议

### 5.1 通信介质

- 走 stdio（避免端口冲突 + 防火墙弹窗）
- 协议：每条消息一行 NDJSON（newline-delimited JSON）
- Main 写 sidecar stdin、读 stdout；stderr 独立 pipe 转日志

### 5.2 协议 schema

```ts
// 请求
type RpcRequest =
  | { id: string; method: 'demucs.split'; params: DemucsSplitParams }
  | { id: string; method: 'ocr.detect';   params: OcrDetectParams }
  | { id: string; method: 'diarize.run';  params: DiarizeParams }
  | { id: string; method: 'embed.speaker'; params: EmbedParams }
  | { id: string; method: 'shot.detect';  params: ShotDetectParams }
  | { id: string; method: 'system.shutdown'; params: {} }
  | { id: string; method: 'system.ping';     params: {} }

// 响应
type RpcResponse<T = unknown> =
  | { id: string; result: T }
  | { id: string; error: { code: string; message: string; retriable: boolean } }

// 进度通知（无 id，单向）
type RpcNotification =
  | { method: 'progress'; params: { taskId: string; percent: number; message?: string } }
  | { method: 'log';      params: { level: 'info' | 'warn' | 'error'; msg: string } }
```

### 5.3 关键 handler 入参 / 出参

```ts
// Demucs：人声 / 背景分离
type DemucsSplitParams = {
  taskId: string
  inputPath: string       // wav/mp3/flac/m4a 都 OK，Python 侧统一 ffmpeg 转 wav
  outputDir: string
  model: 'htdemucs' | 'htdemucs_ft'
  device: 'auto' | 'cpu' | 'cuda' | 'mps'  // auto = mps on Apple Silicon, cuda on Win N卡, 否则 cpu
}
type DemucsSplitResult = {
  vocalsPath: string
  backgroundPath: string
  durMs: number
  device: string          // 实际使用的 device
}

// PaddleOCR：硬字幕检测 + 文字识别
type OcrDetectParams = {
  taskId: string
  videoPath: string
  sampleFps: number       // 默认 1.0
  roi?: { x: number; y: number; w: number; h: number }  // 没传则全帧
}
type OcrDetectResult = {
  hasHardSubtitle: boolean
  subtitleRect?: { x: number; y: number; w: number; h: number }  // 字幕区域估计
  texts: Array<{ tsMs: number; text: string; box: number[] }>
}

// pyannote：说话人分离
type DiarizeParams = {
  taskId: string
  audioPath: string
  numSpeakersHint?: number   // 可选，给个上界
}
type DiarizeResult = {
  segments: Array<{ startMs: number; endMs: number; speaker: string }>
}

// ECAPA：说话人 embedding（用于跨段聚类校验）
type EmbedParams = {
  taskId: string
  audioPath: string
  segments: Array<{ startMs: number; endMs: number }>
}
type EmbedResult = {
  embeddings: number[][]  // 192-dim ECAPA
}
```

### 5.4 进程监控与重启

- Main 侧 `SidecarSupervisor`：每 30s 发 `system.ping`，3 次失败重启
- Sidecar 启动失败 3 次 → 标记 `degraded`，影响 stages 标记 unavailable，UI 提示
- 重启策略：指数退避 1s / 2s / 5s，最大间隔 30s

### 5.5 模型下载

模型不打进 PyInstaller 产物。Sidecar 启动时检查 `~/.dramaprime/models/<model>/manifest.json` 是否存在；缺失则等待 Main 通过 `model.download` RPC 触发，由 Main 负责 HTTPS 拉取并校验 SHA-256。

---

## 6. Pipeline 状态机与 Stage 抽象

### 6.1 Stage 列表（与 PRD §5 一一对应）

| ID | Stage Name | 类型 | 默认可重试 | 输出 | 阻塞下游 |
| :-: | :-- | :-- | :-: | :-- | :-: |
| 1 | `preprocess` | utilityProcess | ✅ | metadata.json, thumbs/ | ✅ |
| 2 | `import-precheck` | utilityProcess | ✅ | precheck.json (硬字幕警告) | ❌（仅警告） |
| 3 | `shot-detect` | sidecar | ✅ | shots.json | ❌ |
| 4 | `demix` | sidecar | ✅ | stems/vocals.wav, stems/music.wav | ✅ |
| 5 | `asr-diarize` | provider(volcengine) | ✅ | asr.json | ✅ |
| 6 | `ocr-assist` | sidecar | ❌（失败仅降级，不阻塞）| ocr.json | ❌ |
| 7 | `cluster` | main 本地算法 | ✅ | characters.json | ✅ |
| 8 | `voice-clone` | provider(MiniMax) | ✅ | voices/<char>.json | ✅ |
| 9 | `translate` | provider(MiniMax) | ✅ | translations.json | ✅ |
| 10 | `tts-synth` | provider(MiniMax) | ✅ | tts/<seg>.wav | ✅ |
| 11 | `align` | main 本地算法 | ✅ | align.json + 改写 tts/<seg>.wav | ✅ |
| 12 | `subtitle-burn` | utilityProcess(ffmpeg) | ✅ | subs/out.ass | ❌（可选） |
| 13 | `mix-render` | utilityProcess(ffmpeg) | ✅ | render/out.mp4 | ✅ |
| 14 | `finalize` | main | ✅ | manifest.json + 入库索引 | ✅ |

### 6.2 Stage 抽象接口

```ts
// packages/pipeline-core/src/stage.ts
export interface StageContext {
  projectId: string
  projectDir: string
  config: ProjectConfig
  providers: ProviderRegistry
  sidecar: SidecarClient
  logger: Logger
  signal: AbortSignal
  reportProgress: (percent: number, message?: string) => void
  reportCost: (delta: CostEntry) => void          // 增量上报
}

export type StageResult =
  | { kind: 'ok'; outputs: Record<string, string>; durationMs: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: NormalizedError }

export interface Stage<P = unknown> {
  name: StageName
  version: number                           // bump 后强制重跑
  inputsFrom: StageName[]                   // 上游依赖
  prepare?: (ctx: StageContext) => Promise<P>
  run: (ctx: StageContext, prepared: P) => Promise<StageResult>
  validate?: (ctx: StageContext, result: StageResult) => Promise<boolean>
}
```

### 6.3 状态机

```
              ┌───────────┐
              │ pending   │
              └─────┬─────┘
                    │ start()
                    ▼
              ┌───────────┐
       ┌──── │ running   │ ─── abort() ─→ ┌───────────┐
       │      └─────┬─────┘                │ aborted   │ ←─ user pause
       │            │                      └───────────┘
       │            ├── ok ─────────→ ┌───────────┐
       │            │                  │ done      │
       │            │                  └───────────┘
       │            └── err ─────────→ ┌───────────┐
       │                                │ failed    │
       │                                └─────┬─────┘
       │                                      │ retry(stage)
       └──────────────────────────────────────┘
```

### 6.4 Orchestrator 行为

```ts
class PipelineOrchestrator {
  async run(projectId: string, opts?: { resumeFrom?: StageName }) {
    const project = await this.repo.load(projectId)
    const stages = this.planStages(project, opts?.resumeFrom)
    for (const stage of stages) {
      if (this.signal.aborted) break
      const result = await this.runStage(project, stage)
      await this.repo.upsertStage(projectId, stage.name, result)
      this.emit('stage-done', { projectId, stage: stage.name, result })
      if (result.kind === 'failed' && stage.blocking) {
        this.emit('error', { projectId, stage: stage.name, error: result.error })
        break
      }
    }
  }

  private async runStage(project: Project, stage: Stage) {
    const ctx = this.buildContext(project, stage)
    const t0 = Date.now()
    try {
      const prepared = stage.prepare ? await stage.prepare(ctx) : undefined
      const result = await withRetry(
        () => stage.run(ctx, prepared as any),
        { retries: stage.retries ?? 3, backoff: 'expo+jitter' }
      )
      if (stage.validate && result.kind === 'ok') {
        const ok = await stage.validate(ctx, result)
        if (!ok) return { kind: 'failed', error: errs.validationFailed(stage.name) }
      }
      return { ...result, durationMs: Date.now() - t0 }
    } catch (err) {
      return { kind: 'failed', error: normalizeError(err) }
    }
  }
}
```

### 6.5 Checkpoint 与断点续跑

每个 stage 结束（不论成败）写入 `stages` 表（详见 §11.2）。重启应用后：

1. 读取 `projects` 表中所有 `status='running' | 'paused'` 的项目
2. 对每个项目，从最早的 `pending | failed` stage 开始续跑
3. 上游已 `done` 的 stage 输出路径直接复用

---

## 7. Provider 抽象层

### 7.1 接口契约

```ts
// packages/core-types/src/providers.ts
export interface LlmProvider {
  name: string
  chat(input: ChatInput, signal?: AbortSignal): Promise<ChatOutput>
  estimateCost(input: ChatInput): Promise<CostEstimate>
}

export interface TtsProvider {
  name: string
  synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsOutput>
  listVoices(): Promise<Voice[]>
  estimateCost(input: TtsInput): Promise<CostEstimate>
}

export interface VoiceCloneProvider {
  name: string
  upload(samplePath: string, signal?: AbortSignal): Promise<{ fileId: string }>
  clone(input: CloneInput, signal?: AbortSignal): Promise<{ voiceId: string; expiresAt: number }>
  promote(voiceId: string): Promise<void>      // 触发首次合成将临时音色永久化
}

export interface AsrProvider {
  name: string
  transcribe(input: AsrInput, signal?: AbortSignal): Promise<AsrOutput>
  estimateCost(input: AsrInput): Promise<CostEstimate>
}

export interface ProviderRegistry {
  llm: LlmProvider
  tts: TtsProvider
  clone: VoiceCloneProvider
  asr: AsrProvider
}
```

### 7.2 中间件链

每个 Provider 调用都过统一中间件栈：

```
caller → [auth] → [rate-limit] → [retry] → [observability] → [provider impl]
```

- **auth**：从 Keystore 取 key，注入 header；token 过期检测
- **rate-limit**：客户端 token bucket，按 provider × model 维度限速；超限排队
- **retry**：HTTP 5xx / 429 / 网络错误自动重试；指数退避 + jitter；最大 N 次
- **observability**：耗时、成本、请求 id 记日志；上报到 `event:provider:health`

```ts
// 伪代码
export const createMiddleware = (next: ProviderCall): ProviderCall =>
  async (ctx, req) => {
    const t0 = Date.now()
    try {
      const res = await retry(() => rateLimit(() => auth(next))(ctx, req), policy)
      log.info({ provider: ctx.provider, ms: Date.now()-t0, costCents: res.costCents })
      return res
    } catch (err) {
      metrics.fail(ctx.provider)
      throw err
    }
  }
```

---

## 8. MiniMax Client 详细设计

### 8.1 Base URL 与鉴权

```ts
// packages/provider-MiniMax/src/client.ts
export const MINIMAX_BASE_URL = 'https://api.minimaxi.chat'  // 国内站点（实际值在产品设置中允许覆盖）
export const MINIMAX_DEFAULT_TIMEOUT_MS = 60_000

export interface MiniMaxConfig {
  apiKey: string
  groupId?: string             // 部分接口需要
  baseUrl?: string
  timeoutMs?: number
}

const buildHeaders = (cfg: MiniMaxConfig) => ({
  'Authorization': `Bearer ${cfg.apiKey}`,
  'Content-Type': 'application/json',
})
```

> ⚠️ 实际 base URL 字符串以 MiniMax 官方文档为准；产品启动时调一次 `/health` 验证；用户可在设置里覆盖（应对未来域名变更）。

### 8.2 LLM 翻译

```ts
// 调用 MiniMax-M3 chatcompletion_v2（OpenAI 兼容）
export class MiniMaxLlmProvider implements LlmProvider {
  name = 'MiniMax'
  constructor(private cfg: MiniMaxConfig, private http: Http) {}

  async chat(input: ChatInput, signal?: AbortSignal): Promise<ChatOutput> {
    const body = {
      model: input.model ?? 'MiniMax-M3',
      messages: input.messages,
      temperature: input.temperature ?? 0.6,
      max_tokens: input.maxTokens ?? 4096,
      stream: false,
      response_format: input.expectJson ? { type: 'json_object' } : undefined,
    }
    const res = await this.http.post(
      `${this.cfg.baseUrl ?? MINIMAX_BASE_URL}/v1/text/chatcompletion_v2`,
      body,
      { headers: buildHeaders(this.cfg), signal, timeoutMs: MINIMAX_DEFAULT_TIMEOUT_MS }
    )
    return {
      text: res.choices[0].message.content,
      usage: {
        promptTokens: res.usage.prompt_tokens,
        completionTokens: res.usage.completion_tokens,
      },
      costCents: estimateLlmCost(input.model ?? 'MiniMax-M3', res.usage),
    }
  }
}
```

### 8.3 TTS 合成

- **短文本（< 10k 字符）** → 同步 HTTP T2A
- **批量合成**（每集 N 句，每句独立 voice + 时长目标） → **逐句 同步 HTTP**（并发受限于 rate-limit）
- **超长文本**（罕见，导出 audiobook）→ 异步 async-create + async-query 轮询

```ts
export class MiniMaxTtsProvider implements TtsProvider {
  name = 'MiniMax'

  async synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsOutput> {
    const body = {
      model: input.model ?? 'speech-2.8-hd',
      text: input.text,
      voice_id: input.voiceId,
      speed: input.speed ?? 1.0,    // [0.5, 2.0]
      vol: input.vol ?? 1.0,
      pitch: input.pitch ?? 0,
      format: 'wav',                 // wav 便于 SOLA 处理
      sample_rate: 32000,
      language_boost: input.languageBoost,  // 提升小语种音色稳定性
      emotion: input.emotion,        // happy/sad/angry/neutral/...
    }
    const res = await this.http.post(
      `${this.cfg.baseUrl ?? MINIMAX_BASE_URL}/v1/t2a_v2`,
      body,
      { headers: buildHeaders(this.cfg), signal, timeoutMs: 60_000 }
    )
    // MiniMax 同步接口直接返回 audio (base64 或 url，按官方为准)
    const buf = await this.materializeAudio(res)
    return {
      audioBuf: buf,
      durationMs: estimateWavDurationMs(buf),
      costCents: estimateTtsCost(input.text.length, input.model),
    }
  }
}
```

### 8.4 Voice Clone（三步走）

```ts
export class MiniMaxVoiceCloneProvider implements VoiceCloneProvider {
  async upload(samplePath: string, signal?: AbortSignal) {
    // 1. multipart 上传到 /v1/files/upload，purpose=voice_clone
    const fd = new FormData()
    fd.append('purpose', 'voice_clone')
    fd.append('file', await readBlob(samplePath))
    const res = await this.http.postMultipart(
      `${MINIMAX_BASE_URL}/v1/files/upload`,
      fd,
      { headers: { 'Authorization': `Bearer ${this.cfg.apiKey}` }, signal }
    )
    return { fileId: res.file.file_id }
  }

  async clone(input: CloneInput, signal?: AbortSignal) {
    // 2. 调 /v1/voice_clone
    const body = {
      file_id: input.fileId,
      voice_id: input.suggestedVoiceId,   // 用户自定义 voice_id，否则平台分配
      need_noise_reduction: true,
      need_volume_normalization: true,
      model: input.model ?? 'speech-2.8-hd',
    }
    const res = await this.http.post(
      `${MINIMAX_BASE_URL}/v1/voice_clone`,
      body,
      { headers: buildHeaders(this.cfg), signal }
    )
    return {
      voiceId: res.voice_id,
      expiresAt: Date.now() + 168 * 3600 * 1000,   // 7 天临时
    }
  }

  async promote(voiceId: string) {
    // 3. 触发一次最小合成（"测试"），把临时音色"用过一次"转永久 + 计费
    await this.ttsProvider.synthesize({
      text: 'Voice promotion.',
      voiceId,
      model: 'speech-2.8-hd',
    })
  }
}
```

### 8.5 限流策略

| 模型 | 默认 QPS | 备注 |
| :-- | :-: | :-- |
| MiniMax-M3 | 5 | 长上下文 token 消耗大，并发保守 |
| speech-2.8-hd | 10 | 短合成 |
| speech-2.8-turbo | 20 | Turbo 更快，QPS 高 |
| voice_clone | 2 | 上传 + clone 耗时 |

> 实际值以官方为准；产品在设置里暴露「QPS 上限」让用户根据账户级别调整。

---

## 9. 火山豆包 ASR Client 详细设计

### 9.1 模型选择

短剧场景（单集 60-180s）特点：**离线、追求高准确率、需要说话人分离**。优先使用 **录音文件识别（异步长音频）API**，不走流式。

```ts
// 占位接口，具体模型 ID / endpoint 待用户在设置里配置
export interface VolcAsrConfig {
  appId: string
  accessToken: string
  cluster: string                  // 火山 ASR cluster id
  endpoint?: string                // 默认值留空，由 client 拼接
  modelId?: string                 // 例如 bigmodel / volc-paraformer-large
}
```

### 9.2 调用流程

```
1. 准备音频：从 demix 阶段拿 vocals.wav (16k mono PCM)
2. PUT 音频到火山对象存储（TOS） 或 直接 base64 短传
3. POST 创建任务 → taskId
4. 轮询 GET 任务状态（间隔 2s → 5s → 10s 退避）
5. 完成后下载结果 JSON，含：
   - text (整段)
   - words: [{ start, end, word, speaker_id }]
   - utterances: [{ start, end, text, speaker_id }]
6. 转换为标准 Segment[]
```

### 9.3 标准化输出

```ts
type AsrUtterance = {
  startMs: number
  endMs: number
  text: string
  confidence: number
  speakerId: string       // 火山返回的 speaker tag, e.g. "spk_0"
}
type AsrOutput = {
  language: string
  utterances: AsrUtterance[]
  speakers: { id: string; sampleCount: number; totalDurMs: number }[]
}
```

### 9.4 重试与缓存

- 同一音频 hash → 命中本地缓存（避免重复花钱）
- 任务失败重试 3 次，每次延 30s
- 长音频（> 10min）切片处理，最后拼接（v1.0 短剧场景一般用不到）

---

## 10. 时长对齐算法实现

### 10.1 数据结构

```ts
type AlignTarget = {
  segmentId: string
  originalStartMs: number
  originalEndMs: number
  originalDurMs: number
  characterId: string
  src: string            // 中文原文
  tgt: string            // 译文
  ttsAudioPath: string
  ttsDurMs: number       // 当前合成时长
}

type AlignDecision = {
  strategy: 'fit' | 'speed' | 'sola' | 'gap-borrow' | 'video-slow' | 'overflow'
  appliedSpeed?: number       // TTS speed 调节量
  appliedSolaRatio?: number   // 弹性变速比例
  borrowedFrom?: 'prev' | 'next'
  videoSlowRatio?: number     // 视频局部慢放比例（±5% 内）
  finalDurMs: number
  offsetMs: number            // 与原段偏差
  flag: 'green' | 'yellow' | 'red'   // < 100ms / < 200ms / >= 200ms
}
```

### 10.2 主流程（packages/align-engine）

```ts
export async function alignSegments(
  targets: AlignTarget[],
  ctx: AlignContext
): Promise<AlignDecision[]> {
  const decisions: AlignDecision[] = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const ratio = t.ttsDurMs / t.originalDurMs
    let decision: AlignDecision

    // Stage 2：TTS 已经合成完。检查是否在容差内
    if (Math.abs(t.ttsDurMs - t.originalDurMs) <= ctx.tolerance) {
      decision = { strategy: 'fit', finalDurMs: t.ttsDurMs, offsetMs: t.ttsDurMs - t.originalDurMs, flag: 'green' }
    }
    // Stage 2 重做：调 TTS speed，重合成（如果偏差中等）
    else if (ratio >= 0.85 && ratio <= 1.15) {
      const newSpeed = clamp(ratio, 0.85, 1.15)
      const newAudio = await ctx.regenerate(t, { speed: newSpeed })
      decision = { strategy: 'speed', appliedSpeed: newSpeed, finalDurMs: newAudio.durMs, offsetMs: newAudio.durMs - t.originalDurMs, flag: flag(newAudio.durMs - t.originalDurMs) }
    }
    // Stage 3：弹性变速（SOLA / rubberband）
    else if (ratio >= 0.7 && ratio <= 1.3) {
      const solaRatio = t.originalDurMs / t.ttsDurMs
      const newAudio = await ctx.applySola(t.ttsAudioPath, solaRatio)
      decision = { strategy: 'sola', appliedSolaRatio: solaRatio, finalDurMs: newAudio.durMs, offsetMs: 0, flag: 'green' }
    }
    // Stage 4：间隙吸收
    else if (canBorrowGap(targets, i)) {
      decision = borrowFromGap(targets, i)
    }
    // Stage 5：视频局部慢放（D2 ✅ 默认 ±5% 内）
    else if (ratio <= 1.05 + ctx.videoSlowMax && !ctx.disableVideoSlow) {
      const videoSlowRatio = t.ttsDurMs / t.originalDurMs - 1   // 例如 0.04 = 慢放 4%
      decision = { strategy: 'video-slow', videoSlowRatio, finalDurMs: t.ttsDurMs, offsetMs: 0, flag: 'green' }
    }
    // Stage 6：放弃 — 标红，等人工处理
    else {
      decision = { strategy: 'overflow', finalDurMs: t.ttsDurMs, offsetMs: t.ttsDurMs - t.originalDurMs, flag: 'red' }
    }
    decisions.push(decision)
  }
  return decisions
}
```

> 注意：Stage 1（控长翻译）在 §6 的 `translate` stage 已经做了——这里收到的 `tgt` 已经是 prompt 注入了 char_budget 后的产物，align 不需要再调 LLM。

### 10.3 SOLA / WSOLA 实现

- 用 **librubberband-cli** 静态二进制（随 ffmpeg 一起打包），支持 `--time` 参数做不变音高变速
- Node 端 spawn rubberband 子进程；输入 wav，输出 wav

```bash
rubberband --time 1.15 --frequency 0 --crisp 5 input.wav output.wav
```

### 10.4 视频局部慢放（D2 ✅）

`mix-render` 阶段统一处理：把所有 `strategy: 'video-slow'` 的段，在 ffmpeg filter graph 中对视频段使用 `setpts=PTS*<ratio>`，对相邻段衔接处理。

---

## 11. 存储层：SQLite 完整 DDL

### 11.1 初始化与迁移

- 使用 `better-sqlite3` + 手写迁移（不用 ORM，避免抽象惩罚）
- 迁移文件 `migrations/0001_init.sql`、`0002_xxx.sql`，启动时按序应用
- 元数据表 `schema_migrations(version, applied_at)`

### 11.2 完整 DDL（v1.0）

```sql
-- 项目
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_lang     TEXT NOT NULL DEFAULT 'zh',
  target_lang     TEXT NOT NULL,                       -- ISO code, e.g. 'en','es','ar'
  source_path     TEXT NOT NULL,                       -- 绝对路径或工程相对路径
  source_size_bytes INTEGER,
  source_dur_ms   INTEGER,
  status          TEXT NOT NULL,                       -- created|running|paused|done|failed
  current_stage   TEXT,
  config_json     TEXT NOT NULL,                       -- ProjectConfig (JSON)
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);

-- Stage 执行记录
CREATE TABLE stages (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL,                       -- 14 个 stage 之一
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,                       -- pending|running|done|failed|skipped|aborted
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  inputs_hash     TEXT,                                -- 上游输出 hash，决定是否需要重跑
  outputs_json    TEXT,                                -- {key: path}
  error_json      TEXT,
  PRIMARY KEY (project_id, stage)
);

-- 句段（最小调度单元）
CREATE TABLE segments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,                    -- 在视频内的顺序
  scene_idx       INTEGER,                             -- shot-detect 输出的 scene 索引
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  speaker_id      TEXT,                                -- ASR 原始 speaker tag
  character_id    TEXT REFERENCES characters(id),
  src_text        TEXT,                                -- ASR 原文
  src_text_edited TEXT,                                -- 用户编辑后的原文
  ocr_text        TEXT,                                -- OCR 字幕文本（辅助）
  tgt_text        TEXT,                                -- 译文
  tgt_text_edited TEXT,                                -- 用户编辑后的译文
  tgt_audio_path  TEXT,                                -- TTS 产物绝对路径
  tgt_dur_ms      INTEGER,
  align_decision_json TEXT,                            -- AlignDecision (JSON)
  locked          INTEGER NOT NULL DEFAULT 0,          -- 用户锁定，不参与重跑
  emotion         TEXT,                                -- happy|sad|angry|neutral|...
  flag            TEXT,                                -- green|yellow|red
  UNIQUE (project_id, idx)
);
CREATE INDEX idx_segments_project ON segments(project_id);
CREATE INDEX idx_segments_character ON segments(character_id);

-- 角色（项目级）
CREATE TABLE characters (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT,                                -- 用户命名
  speaker_id      TEXT NOT NULL,                       -- 对应 ASR 的 speaker tag
  gender          TEXT,                                -- male|female|unknown
  age_band        TEXT,                                -- child|young|adult|elder
  voice_id        TEXT,                                -- MiniMax voice_id
  voice_status    TEXT,                                -- system|temp|permanent
  voice_expires_at INTEGER,
  needs_reclone   INTEGER NOT NULL DEFAULT 0,          -- D3 ✅ 标记
  sample_path     TEXT,                                -- 克隆样本片段
  sample_score    REAL,                                -- FR-CHAR-03 自动评分
  embedding_blob  BLOB                                 -- ECAPA 192-dim float32
);
CREATE INDEX idx_characters_project ON characters(project_id);

-- 跨项目音色资产库
CREATE TABLE voice_assets (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  voice_id        TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL DEFAULT 'MiniMax',
  status          TEXT NOT NULL,                       -- temp|permanent
  expires_at      INTEGER,
  tags_json       TEXT,
  origin_project_id TEXT,
  sample_path     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_voice_assets_status ON voice_assets(status);

-- 术语表 / 译名表
CREATE TABLE term_glossary (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,                       -- 'global' | <project_id>
  src             TEXT NOT NULL,
  tgt             TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (scope, src, target_lang)
);

-- 成本明细
CREATE TABLE cost_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  stage           TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  units           INTEGER NOT NULL,                    -- tokens 或 字符 或 秒
  unit_kind       TEXT NOT NULL,                       -- 'tokens'|'chars'|'seconds'
  cents           INTEGER NOT NULL,
  request_id      TEXT,
  ts              INTEGER NOT NULL
);
CREATE INDEX idx_cost_project ON cost_entries(project_id);
CREATE INDEX idx_cost_ts ON cost_entries(ts);

-- 批量任务
CREATE TABLE batches (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  template_json   TEXT NOT NULL,                       -- 批量模板
  status          TEXT NOT NULL,                       -- queued|running|done|partial|cancelled
  created_at      INTEGER NOT NULL
);
CREATE TABLE batch_items (
  batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  ord             INTEGER NOT NULL,
  status          TEXT NOT NULL,                       -- queued|running|done|failed
  PRIMARY KEY (batch_id, project_id)
);

-- Provider 调用审计（用于 debug，按需开）
CREATE TABLE provider_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT,
  provider        TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_id      TEXT,
  status_code     INTEGER,
  latency_ms      INTEGER,
  err_code        TEXT,
  ts              INTEGER NOT NULL
);

-- Schema 版本
CREATE TABLE schema_migrations (
  version         INTEGER PRIMARY KEY,
  applied_at      INTEGER NOT NULL
);
```

### 11.3 仓库（Repository）接口

```ts
// main/storage/repos.ts
export interface ProjectRepo {
  create(input: CreateProjectInput): ProjectId
  get(id: ProjectId): ProjectDetail
  list(filter?: ProjectFilter): ProjectSummary[]
  updateStatus(id: ProjectId, status: ProjectStatus, currentStage?: StageName): void
  delete(id: ProjectId): void
}
export interface StageRepo {
  upsert(projectId: ProjectId, stage: StageName, patch: StagePatch): void
  load(projectId: ProjectId): StageRecord[]
  reset(projectId: ProjectId, stage: StageName): void
}
export interface SegmentRepo {
  bulkInsert(projectId: ProjectId, segs: SegmentInsert[]): void
  list(projectId: ProjectId): Segment[]
  patch(id: string, patch: SegmentPatch): void
}
// ... CharacterRepo / VoiceAssetRepo / CostRepo / BatchRepo
```

事务边界：每个 stage 的 checkpoint 写入是一个事务（项目状态 + stage 记录 + 成本明细 一并提交）。

---

## 12. 文件系统与缓存布局

### 12.1 目录约定（macOS / Windows 等价）

```
<userData>/                              # app.getPath('userData')
├── config.json                          # 应用全局配置（非敏感）
├── projects.db                          # SQLite
├── projects.db-shm                      # SQLite WAL
├── projects.db-wal
├── logs/
│   └── YYYY-MM-DD.log                   # pino + pino-roll
├── cache/
│   ├── models/
│   │   ├── demucs/htdemucs/...
│   │   ├── paddleocr/...
│   │   ├── pyannote/...
│   │   └── ecapa/...
│   ├── fonts/                           # 按需下载的字体包
│   └── ffmpeg-temp/                     # ffmpeg 中间临时
└── projects/
    └── <project-id>/
        ├── source.mp4                   # 原视频（或符号链接到用户路径）
        ├── thumbs/                      # 缩略图
        ├── stems/
        │   ├── vocals.wav
        │   └── music.wav
        ├── asr.json
        ├── ocr.json
        ├── shots.json
        ├── characters.json
        ├── voices/<char-id>/
        │   ├── sample.wav
        │   └── meta.json
        ├── translations.json
        ├── tts/
        │   ├── <seg-id>.wav             # 原始合成
        │   └── <seg-id>.aligned.wav     # 对齐后
        ├── align.json
        ├── subs/
        │   └── out.ass
        ├── render/
        │   └── out.mp4
        └── stage-locks/                 # 运行中标记文件，崩溃恢复用
            └── <stage>.lock
```

### 12.2 Renderer 访问本地文件

注册自定义 `app://` 协议（safer than `file://`）：

```ts
// main/protocol.ts
protocol.handle('app', async (req) => {
  const url = new URL(req.url)
  const absPath = resolveSafe(url.pathname, allowedRoots)
  if (!absPath) return new Response('forbidden', { status: 403 })
  return net.fetch(pathToFileURL(absPath).toString())
})
```

Renderer 通过 `<video src="app:///projects/<id>/source.mp4">` 直接播放，无需把视频读到 JS。

### 12.3 工程包导入 / 导出（.dpx）

- 格式：zip（无加密；后续可选加密）
- 内含 `manifest.json` + 所有中间产物（可选不含原视频，只存路径指针）
- 导入时验签 + 反序列化 + 拷贝到 `projects/<new-id>/`

---

## 13. 密钥管理与安全

### 13.1 Key 存储

```ts
// main/keystore/index.ts
import keytar from 'keytar'

const SERVICE = 'DramaPrime'

export const Keys = {
  MINIMAX_API_KEY: 'MiniMax.api_key',
  MINIMAX_GROUP_ID: 'MiniMax.group_id',
  VOLC_APP_ID: 'volcengine.app_id',
  VOLC_ACCESS_TOKEN: 'volcengine.access_token',
  VOLC_CLUSTER: 'volcengine.cluster',
} as const

export class Keystore {
  get(key: KeyName): Promise<string | null> {
    return keytar.getPassword(SERVICE, key)
  }
  set(key: KeyName, value: string): Promise<void> {
    return keytar.setPassword(SERVICE, key, value)
  }
  delete(key: KeyName): Promise<boolean> {
    return keytar.deletePassword(SERVICE, key)
  }
}
```

### 13.2 测试连接

`keystore:test` IPC：

```ts
// 用最低成本的探活调用
async function testMiniMax(): Promise<TestResult> {
  try {
    // 调一次 0-token chat（或专用 ping endpoint，若官方提供）
    await llm.chat({ messages: [{role:'user', content:'.'}], maxTokens: 1 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeError(e).message }
  }
}
```

### 13.3 日志脱敏

- pino redact path：`['*.apiKey', '*.access_token', '*.authorization', 'req.headers.authorization']`
- 上传调试报告前再过一遍 redact

### 13.4 进程沙箱

- Renderer：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`
- Preload 严格白名单，不暴露 `require` / `process`
- CSP：`default-src 'self' app:; media-src app: blob:; img-src app: data: https:`

---

## 14. 错误模型与重试策略

### 14.1 统一错误类型

```ts
export type ErrorCode =
  // provider 类
  | 'provider.unauthorized'
  | 'provider.rate-limited'
  | 'provider.payment-required'
  | 'provider.timeout'
  | 'provider.bad-request'
  | 'provider.upstream-5xx'
  | 'provider.network'
  // sidecar 类
  | 'sidecar.crashed'
  | 'sidecar.method-not-found'
  | 'sidecar.model-missing'
  // ffmpeg 类
  | 'ffmpeg.encode-failed'
  | 'ffmpeg.input-corrupted'
  // 业务类
  | 'pipeline.upstream-missing'
  | 'pipeline.validation-failed'
  | 'pipeline.aborted'
  // 用户输入
  | 'user.invalid-input'
  | 'user.file-not-found'

export interface NormalizedError {
  code: ErrorCode
  message: string
  cause?: string
  retriable: boolean
  retryAfterMs?: number
  context?: Record<string, unknown>
}
```

### 14.2 重试矩阵

| 类型 | 重试 | 退避 | 最大尝试 |
| :-- | :-: | :-- | :-: |
| `provider.rate-limited` | ✅ | 优先使用 `Retry-After`；否则 expo+jitter | 5 |
| `provider.timeout` | ✅ | expo+jitter，base=1s | 3 |
| `provider.upstream-5xx` | ✅ | expo+jitter | 3 |
| `provider.network` | ✅ | expo+jitter | 5 |
| `provider.unauthorized` | ❌ | — | 1 |
| `provider.bad-request` | ❌ | — | 1 |
| `provider.payment-required` | ❌ | — | 1 |
| `sidecar.crashed` | ✅ | 拉起后即重试 | 2 |
| `sidecar.model-missing` | ❌ | 触发下载流程 | 1 |
| `ffmpeg.encode-failed` | ✅ | 切换 preset 后重试一次 | 2 |
| `ffmpeg.input-corrupted` | ❌ | — | 1 |
| `pipeline.aborted` | ❌ | 用户取消，不重试 | 1 |

### 14.3 退避算法

```ts
const computeBackoff = (attempt: number, baseMs = 1000, capMs = 30_000) => {
  const expo = Math.min(capMs, baseMs * 2 ** attempt)
  const jitter = Math.random() * expo * 0.3
  return Math.floor(expo + jitter)
}
```

---

## 15. 可观测性：日志 / 进度 / 成本

### 15.1 日志

- 库：`pino` + `pino-roll`（按天滚动，保留 14 天）
- 级别：默认 `info`；通过 `--verbose` 启动参数或设置项调到 `debug`
- 结构化字段：`projectId`、`stageName`、`provider`、`requestId`、`durationMs`、`costCents`

### 15.2 进度事件

- 节流：每个 stage 最多每 250ms emit 一次 `event:pipeline:progress`
- 字段：`{ projectId, stage, percent, eta: number|null, costDeltaCents }`
- Renderer 用一个全局 store 接收，分发到各 page

### 15.3 成本面板

- 每次 provider 调用结束，往 `cost_entries` 表插一条
- 项目级聚合 view：

```sql
CREATE VIEW v_project_cost AS
SELECT project_id, SUM(cents) AS total_cents,
       SUM(CASE WHEN provider='MiniMax' AND unit_kind='tokens' THEN cents ELSE 0 END) AS llm_cents,
       SUM(CASE WHEN provider='MiniMax' AND unit_kind='chars' THEN cents ELSE 0 END) AS tts_cents,
       SUM(CASE WHEN provider='volcengine' THEN cents ELSE 0 END) AS asr_cents
FROM cost_entries GROUP BY project_id;
```

### 15.4 崩溃上报

- 用 Electron `crashReporter`；上报前弹窗用户授权
- 上报附带最近 200 行日志（已 redact）
- v1.0 上报地址留接口（自建 endpoint 或 Sentry），不强绑

---

## 16. 打包、签名、自动更新

### 16.1 macOS 签名 + 公证

```yaml
# electron-builder.yml 片段
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    NSMicrophoneUsageDescription: "需要访问麦克风以试听音频" # 仅在确实用到时声明
  artifactName: "${productName}-${version}-${arch}.${ext}"
```

`entitlements.mac.plist` 至少包含：

- `com.apple.security.cs.allow-jit`（V8）
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`（sidecar Python 需要）

### 16.2 Windows 签名

- EV Code Signing 证书（解决 SmartScreen 信任）
- nsis + portable 双产物
- 安装路径默认 `%LOCALAPPDATA%\DramaPrime\`（不需要管理员权限）

### 16.3 自动更新

- `electron-updater` + 自托管 feed
- feed 结构：`latest-mac.yml`、`latest.yml`（Win）
- 更新策略：启动后延迟 30s 检查；用户可关闭
- 差分更新（blockmap）：Win 全量、Mac 全量；v1.1 评估差分

### 16.4 模型 / 字体按需下载

- 启动时检查必需模型清单；缺失时弹窗引导
- 多 CDN：默认走阿里 OSS，备份华为云
- 下载有 SHA-256 校验 + 断点续传

---

## 17. 测试策略

### 17.1 测试金字塔

| 层 | 工具 | 覆盖目标 |
| :-- | :-- | :-- |
| 单元（业务） | Vitest | provider client、align engine、cost 计算、glossary 替换 |
| 单元（UI） | Vitest + Testing Library | 组件交互、store 逻辑 |
| 集成（IPC） | Vitest + electron mock | preload ↔ main 通道 |
| 集成（Pipeline） | Vitest + 真 sidecar | 单 stage 端到端 |
| E2E | Playwright + electron | 关键用户流程（建项目 → 译制 → 导出） |
| 回归（质量） | 自动脚本 | §14 验收指标（BLEU、对齐偏差等），见 PRD 附录 A.5 |

### 17.2 关键 mock

- Provider mock：可重放真实响应（录制一次保存到 fixtures）
- Sidecar mock：实现同一 JSON-RPC 协议的 mock 进程
- ffmpeg：用 fake 二进制（输出固定文件）测试调度逻辑

### 17.3 CI

- GitHub Actions 矩阵：macOS-14 (arm64) / macOS-13 (x64) / windows-2022
- 每次 PR：lint + typecheck + unit + 部分集成
- 主分支：上述全部 + 打包 dry-run（不签名）
- Release tag：上述全部 + 真签名 + 公证 + 上传 feed

---

## 18. 技术决策记录与新决策点

### 18.1 与 PRD 决议的对应

| PRD 决议 | TDD 落地 |
| :-- | :-- |
| D1 Electron | §1, §2, §3, §16 全部 |
| D2 视频慢放 ±5% | §10 align engine Stage 5；ffmpeg `setpts` 限幅 |
| D3 短样本 → 系统音色 + reclone 标记 | §11 `characters.needs_reclone` 字段 |
| D4 v1.0 不做抠除 | §6 stage 14 表中无 inpaint stage；`import-precheck` 仅出警告 |
| D5 不做整集润色 | §6 `translate` stage 单次完成 |
| D8 全 40 语种 | §10 align engine 由附录 A K 系数驱动 |
| D10 全自动样本选取 | §6 `cluster` stage 内自动评分 + 写入 `sample_score` |
| D11 地区中性化 | §6 `translate` 加载 `prompts/region_neutral/{lang}.yaml` |
| D12 人工盲测 | TDD 不涉及（运营 SOP） |
| D13 RTL 单语 + 中英双语 | §6 `subtitle-burn` libass 配置；编辑器 dir 切换 |

### 18.2 TDD 新冒出来的技术决策点（请你拍板）

| ID | 问题 | 选项 |
| :-: | :-- | :-- |
| **T1** | Mac 包发行：Universal（大但省维护）vs 双包（小但多维护）？ | A. 只发 Universal（推荐）  B. arm64 + x64 双包  C. 两者都发 |
| **T2** | 数据库选型：SQLite（已默认）vs 文件 JSON（更易导出）vs 嵌入式 DuckDB（强查询）？ | A. SQLite（推荐）  B. SQLite + JSON 工程文件镜像 |
| **T3** | Sidecar 模式：单 Python 长驻进程（默认）vs 每任务一进程 vs Native（Rust + ONNX，无 Python）？ | A. 长驻（推荐）  B. 每任务  C. Native 重写（工程量 +3-5 周） |
| **T4** | ffmpeg 分发：随包 ~80MB 静态二进制（默认）vs 首次启动按需下载 vs 依赖系统已装？ | A. 随包（推荐）  B. 按需下载  C. 系统依赖（用户体验差）|
| **T5** | 翻译并发：每集顺序逐场（默认）vs 同集多场并行 vs 跨集并行（受 QPS 限）？ | A. 单集顺序 + 跨集并行（推荐）  B. 单集多场并行  C. 全顺序最稳 |
| **T6** | TTS 音频格式：WAV 32kHz（默认，便于 SOLA）vs MP3（省空间） vs PCM（最快）？ | A. WAV 32kHz（推荐）  B. PCM raw  C. MP3 |
| **T7** | Demucs 设备策略：自动选（mps/cuda/cpu，默认）vs 用户可选 vs 强制 CPU（兼容性最高）？ | A. 自动 + 用户可覆盖（推荐） |
| **T8** | 进度更新粒度：250ms 节流（默认）vs 100ms（流畅但 IPC 多）vs 1s（省）？ | A. 250ms（推荐） |
| **T9** | Renderer 与 Main 错误格式：`{ok, data?, error?}`（默认）vs Promise.reject + 自定义类？ | A. ok 结构体（推荐）  B. throw |
| **T10** | 加密敏感字段（`projects.db`）：明文（默认）vs SQLCipher（额外 ~3MB + 编译）？ | A. 明文 + 依赖系统盘加密（推荐）  B. SQLCipher 全表加密 |

---

> TDD v0.1 完成。T1-T10 你拍板后我会更新到 v0.2，并准备：
> 1) `electron-vite` 项目脚手架代码  2) 关键模块 stub  3) Pipeline + Stage 抽象的运行 demo
