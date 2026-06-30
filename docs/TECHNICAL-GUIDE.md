# DramaPrime · 技术说明书

> **版本**：v0.4.13（与代码同步）
> **日期**：2026-06-15
> **目标读者**：新加入的开发者 / 二次开发
>
> 端到端工作流见 [`WORKFLOW.md`](./WORKFLOW.md)；产品需求见 [`PRD.md`](./PRD.md)；完整技术设计（含 IPC schema / SQLite DDL）见 [`TDD.md`](./TDD.md)。
>
> 这份文档讲清楚「代码怎么组织、怎么动手改、常见坑」。

---

## 1. 技术栈

| 层 | 选型 | 为什么 |
|:--|:--|:--|
| 桌面壳 | Electron 30+ | 跨 Win/macOS 一次写 |
| Renderer | React 18 + Vite | 主流 + HMR 快 |
| Main | TypeScript（strict） | 类型安全 |
| 数据库 | better-sqlite3 | 同步 API、Electron 兼容好（异步 worker 复杂）|
| 打包 | electron-builder | Win + macOS + icon + signing 一站式 |
| LLM | MiniMax M3 | 国内访问快、Anthropic 兼容、thinking 可关 |
| TTS | MiniMax Speech-2.8 HD | 中文支持最稳（whisper / Google TTS 中文失真多）|
| 视觉 | MiniMax M3 Vision | LLM 同一 SDK 支持多模态 |
| ASR | 火山豆包 Seed-ASR 2.0 | 流式 + 说话人分离一次给 |
| 人声分离 | Facebook Demucs（PyInstaller 打包或 system）| 业界最稳 |
| 密钥 | 系统 keychain（macOS）/ credential store（Win） | keytar 抽象，不写明文到 DB |
| 日志 | pino（multistream 到文件 + stdout） | 无 worker thread，包小 |
| 包管理 | pnpm workspace | monorepo 友好 |

---

## 2. 仓库结构

```
video-translate-new/
├── apps/desktop/                  ← Electron 应用
│   ├── electron-builder.yml       ← 打包配置
│   ├── electron.vite.config.ts     ← 编译配置
│   ├── src/
│   │   ├── main/                  ← Node 进程（IPC handler + pipeline + provider）
│   │   │   ├── stages/            ← 14 stage 真实实现
│   │   │   ├── providers/         ← 4 个 provider 注册
│   │   │   ├── orchestrator/      ← stage 注册 + 持久化
│   │   │   ├── storage/           ← SQLite + 迁移
│   │   │   ├── ipc/               ← 12 个 IPC channel handler
│   │   │   ├── keystore/          ← 系统 keychain 封装
│   │   │   ├── ffmpeg/            ← 抽帧 / loudnorm 封装
│   │   │   └── index.ts            ← main 入口
│   │   ├── preload/               ← contextBridge 暴露的 API
│   │   └── renderer/               ← React UI
│   │       ├── pages/              ← ProjectList / Workbench / Voices / Settings
│   │       ├── components/         ← Workstation / Toast / AlignPanel ...
│   │       └── stores/             ← 全局 zustand-like store
│   └── release/                   ← 打包产物（gitignore）
├── packages/                       ← 纯逻辑包（无 Electron 依赖）
│   ├── pipeline-core/             ← 14 stage mock 实现 + Orchestrator
│   ├── align-engine/              ← 5 级级联策略
│   ├── subtitle/                  ← ASS / SRT 生成
│   ├── provider-MiniMax/         ← MiniMax M3 + Speech-2.8 + voice_clone
│   └── provider-volcengine/       ← 火山豆包 ASR
├── build-resources/               ← 打包图标（icon.png / icon.icns）
├── binaries/                      ← demucs / ffmpeg 静态二进制
├── docs/                          ← 本目录
├── docs/WORKFLOW.md               ← 端到端工作流
├── docs/TDD.md                    ← 完整技术设计
├── docs/PRD.md                    ← 产品需求
├── docs/TECHNICAL-GUIDE.md        ← 本文档
└── build.sh                       ← 一键打包（mac + win）
```

---

## 3. 关键模块

### 3.1 Orchestrator（`packages/pipeline-core/src/orchestrator.ts`）

**职责**：14 阶段状态机 + stage 持久化 + 中断 / 重试 / 跳过逻辑。

```ts
class Orchestrator {
  async run(projectId, opts) {
    // 1. 加载已完成的 stage
    // 2. 计算还没跑的 stage 列表
    // 3. 顺序执行（失败 blocking=true 停 / blocking=false 跳过）
    // 4. 每个 stage 写 stages 表
    // 5. 触发 progress / stage-done / error / finished 事件
  }
}
```

**事件流**（订阅者）：
- `progress(stage, percent, message)` → renderer 进度条
- `stage-done(stage, result, durationMs)` → renderer 刷新状态
- `error(stage, error)` → renderer 红 banner + 全局 toast
- `finished(projectId, status, totalCostCents)` → renderer 绿 banner

**abort 机制**：用 `AbortController`。pause() 调 `controller.abort()`，stage 内部用 `signal.aborted` 检查提前退出。

### 3.2 Provider 抽象（`packages/core-types/src/providers.ts`）

```ts
interface LlmProvider {
  chat(input: ChatInput): Promise<ChatOutput>
}
interface TtsProvider {
  synthesize(input: TtsInput): Promise<TtsOutput>
}
interface AsrProvider {
  transcribe(input: AsrInput): Promise<AsrOutput>
}
interface VoiceCloneProvider {
  clone(input: VoiceCloneInput): Promise<VoiceCloneOutput>
  listClonedVoices(): Promise<VoiceAsset[]>
}
```

**好处**：
- 测试可注入 mock（`makeMockStages()`）
- 未来换 OpenAI / ElevenLabs 不用改 stage 代码
- 每个 provider 一个目录（`packages/provider-MiniMax/`、`packages/provider-volcengine/`）

### 3.3 IPC 协议（`apps/desktop/src/main/ipc/`）

`contextBridge` + `ipcRenderer.invoke` 桥接 renderer ↔ main。

12 个 channel（详见 TDD.md §4）：
- `system:*` 4 个（ready / select-file / read-file-as-data-url / notify）
- `project:*` 5 个（create / list / get / delete / duplicate）
- `segment:*` 3 个（list / assets / resynth）
- `pipeline:*` 4 个（start / status / pause / retry-stage）
- `character:*` 3 个（list / rename / reclone）
- `voice:*` 3 个（list / rename / delete）
- `cluster:*` 2 个

**事件推送**（main → renderer）：
- `event:pipeline:progress`
- `event:pipeline:stage-done`
- `event:pipeline:error`
- `event:pipeline:finished`

### 3.4 SQLite schema（`apps/desktop/src/main/storage/migrations/0001_init.sql`）

7 个表 + 1 个视图：

```
projects      ← 项目元信息 + status
stages        ← 每个 stage 的运行结果（PK project_id + stage）
segments      ← 句段（v0.4.12 多了 thumb_path 字段）
characters    ← 角色（每项目）
voice_assets  ← 跨项目音色库（v0.4.12 新表）
term_glossary ← 术语表（v1.0 用）
cost_entries  ← 成本条目（v0.5 用）
batches       ← 批量任务（v1.1 用）
+ v_project_cost 视图
```

**重要约定**：
- 时间戳都用 `INTEGER` (ms since epoch)
- 路径都存相对路径 `~/Library/Application Support/DramaPrime/...`
- 改 schema 必须新建 `migrations/000N_*.sql`，**不要改旧的**

---

## 4. 关键依赖 + 版本

| 依赖 | 用途 | 备注 |
|:--|:--|:--|
| electron | 30+ | 桌面壳 |
| better-sqlite3 | 数据库 | native module，需 electron-rebuild |
| keytar | 密钥 | 同上 |
| @ffmpeg-installer/ffmpeg | 抽帧 / 转码 | 自动选平台 binary |
| pino | 日志 | 多 stream 输出 |
| zod | 运行时校验 | TDD §4 用 |
| @dramaprime/core-types | 共享类型 | pipeline-core / desktop 都引 |
| @dramaprime/pipeline-core | 14 stage mock | 离线跑通 UI |
| @dramaprime/align-engine | 5 级对齐策略 | 含测试 |
| @dramaprime/subtitle | ASS / SRT | 含测试 |
| @dramaprime/provider-MiniMax | M3 + TTS + clone | 国内 MiniMax |
| @dramaprime/provider-volcengine | 豆包 ASR | 国内火山引擎 |

---

## 5. 常见开发任务

### 5.1 加一个新 stage

```bash
# 1. 在 packages/core-types/src/domain.ts 加 stage 名到 StageName union + ALL_STAGES 数组
# 2. 在 packages/pipeline-core/src/stages/index.ts 加 mock 实现
# 3. 在 apps/desktop/src/main/stages/<name>.ts 写真实实现
# 4. 在 apps/desktop/src/main/orchestrator/index.ts 的 buildStages() 注册
# 5. UI 在 Workbench.tsx 的 STAGE_LABEL 加中文名
```

### 5.2 加一个新的 Provider（接 OpenAI / ElevenLabs 等）

```bash
# 1. 在 packages/core-types/src/providers.ts 加 ProviderName + 接口
# 2. 在 packages/provider-<name>/ 新建包（仿 provider-MiniMax 结构）
# 3. 在 apps/desktop/src/main/providers/index.ts 加 register + 实例化
# 4. 在 stage 里用 providers().<name> 调用
```

### 5.3 加一个新的 IPC channel

```bash
# 1. 在 packages/core-types/src/api.ts 加 channel 类型
# 2. 在 apps/desktop/src/main/ipc/<domain>.ts 加 handler
# 3. preload 暴露的 api 自动 type-safe（基于 ApiSurface）
# 4. 在 renderer 用 window.api.call('domain:action', arg) 调
```

### 5.4 改 schema

```bash
# 1. 在 apps/desktop/src/main/migrations/ 新建 000N_*.sql
# 2. 写 ALTER TABLE / CREATE TABLE（不要改 0001_init.sql）
# 3. 跑应用 → 启动时自动跑新 migration
```

### 5.5 调试一条 segment 的 TTS 链路

```bash
# main 进程日志在 ~/Library/Logs/DramaPrime/2026-06-XX.log
# 用 pino-pretty 风格（直接 cat 也可读）：
tail -F ~/Library/Logs/DramaPrime/2026-06-15.log | grep -E "stage|tts-synth"

# 关键日志字段：
#   segId: <uuid>   ← segments.id
#   srcText: <原文> ← 翻译前
#   tgtText: <译文> ← 翻译后
#   voiceId, emotion, intensity, speed, vol, pitch ← 传给 TTS 的参数
#   newDurMs: <ms>  ← TTS 实际产出时长
#   err: "..."      ← 失败信息
```

---

## 6. 重要开发规范

### 6.1 改 TTS 调用必须按 MiniMax 真实参数

`packages/provider-MiniMax/src/tts.ts` 是唯一的 MiniMax 出口。

**易错点**：
- `voice_setting.pitch` 是 **integer**（-12~12），必须 `Math.round()`，小数会被 API 拒
- `voice_setting.emotion` 8 个白名单值（**无 neutral**），传了会报 2013 降级去 emotion
- `voice_modify.{pitch, intensity, timbre}` 都是 **integer**（-100~100）
- 实际听感上 `voice_modify` 比 `voice_setting` 更"硬件化"（影响声纹），不要混

### 6.2 改 ASR 链必须清 startMs 脏数据

`apps/desktop/src/main/stages/asr-cluster-stages.ts:140-180` 是 segment 写库前最后一道门。

**易错点**：
- 火山豆包对穿插英文歌词返回 `startMs: -1`（卡拉 OK 词级时间戳）—— 必须过滤 `startMs < 0` 和 `endMs <= startMs`
- 中文 ASR 不输出标点，必须靠"词间静音 ≥ 450ms"做切句（silenceCutoffMs）
- 已加防御层在 `SegmentRepo.bulkInsert`（v0.4.10）—— 任何新写入路径都会过滤

### 6.3 改字幕渲染必须走 `packages/subtitle/src/ass.ts`

这是单一 ASS 生成出口。`bottomMarginRatio` 改值要谨慎：
- `0.06` = 距底 6% = 1080p 下 115px（v0.4.12 默认）
- `0.015` = 距底 1.5% = 28px（v0.4.8 太靠下，v0.4.9 改回）

`maxCharsPerLine: 24` 是单行字符上限，wrapCueText 自动按"标点优先、空格次之、硬切兜底"折行（`packages/subtitle/src/wrap.ts`）。

### 6.4 改 character / voice 数据要同步 voice_assets

`voice-clone` 成功后**必须**调 `VoiceAssetRepo.record()`（`apps/desktop/src/main/stages/voice-clone-stage.ts:201`）—— 否则音色库里看不到新复刻的 voice_id。

`voice_assets` 表有 `ON CONFLICT(voice_id) DO NOTHING`：同一 voice_id 跨项目复用时只记录最早来源。

### 6.5 改 storage 必须有 migration

每次 schema 变更：
1. 新建 `migrations/000N_xxx.sql`
2. 改相关 repo 方法（如果字段名变了）
3. 跑应用测试一次：启动时 main 进程会自动执行未应用的 migration

不要直接改 `0001_init.sql`——老的 SQLite DB 已经 apply 过了，不会再跑。

---

## 7. 性能 / 容量

| 项 | 限制 | 备注 |
|:--|:--|:--|
| SQLite 单 DB | < 1TB | 单项目几 MB |
| 项目目录 | < 10GB | 含 demix vocals / TTS mp3 / 渲染 out.mp4 |
| ASR 实时 | 0.7x | 1 分钟视频 ~40s 出结果 |
| TTS 实时 | 1.5x | 1 分钟字幕 ~90s 合成 |
| M3 LLM | 100-200ms/批 | 12 句/批 |
| M3 VLM | 1.5-3s/帧 | 90 帧/分钟视频 |

---

## 8. 调试 Checklist

| 症状 | 检查 |
|:--|:--|
| 启动报「项目正在运行中」 | 查 `projects.status` DB 字段、是否有孤儿运行 |
| TTS 全是 soft、没感情 | 1) ASR emotion 字段？ 2) emotion 是否在 MiniMax 白名单？ 3) loudnorm 后处理是否压回响度？|
| 字幕与原片对不上 | ocr-assist 跑通了吗？VLM 60s 超时？抽帧密度够吗？|
| 短句嘶吼不狠 | 检查 `isShortShoutSegment` 触发；voice_modify {pitch/intensity/timbre} 整数化了吗？|
| Demucs 卡住 | 看 `~/Library/Logs/DramaPrime/...log` 找 "demucs" 关键字；是 binary 缺失还是 PyInstaller 崩？|
| 主进程 IPC 事件丢失 | 检查 `event:*` 订阅的 cleanup（workbench.tsx line 88-90）|
| 进度停滞 | v0.4.11 已加 3s 兜底轮询；如还停滞查 `projects.status` 是否被 stuck 在 running |

---

## 9. 发版 Checklist

| 项 | 工具 |
|:--|:--|
| 类型检查 | `pnpm typecheck` |
| 单元测试 | `pnpm test` |
| 打包（mac + win） | `./build.sh` |
| 产物路径 | `apps/desktop/release/DramaPrime-*.dmg` / `*.exe` |
| 端到端冒烟 | 打开新建项目 → 选短片 → ▶ 开始 → 等 5 分钟 → 看 `out.mp4` |
| 版本号 | 改 `package.json` 的 `version` + `apps/desktop/package.json` 同步 |

---

## 10. 相关文档

| 文档 | 内容 |
|:--|:--|
| [`WORKFLOW.md`](./WORKFLOW.md) | 端到端工作流 + 14 stage 流程图 + 参数表 |
| [`PRD.md`](./PRD.md) | 产品需求 + D1-D13 决策 + 风险 + Roadmap |
| [`TDD.md`](./TDD.md) | 完整技术设计：IPC schema / SQLite DDL / Provider 接口 / 错误模型 |
| [`TECH-OVERVIEW-v0.5.md`](./TECH-OVERVIEW-v0.5.md) | 早期概览（部分过时，仅供历史参考）|
| [`../RUNBOOK.md`](../RUNBOOK.md) | 部署 + 排错实战 |

---

## 11. 术语表

| 术语 | 含义 |
|:--|:--|
| **stage** | 14 阶段 pipeline 中的一步 |
| **provider** | 外部 AI 服务的封装（LLM/TTS/ASR/Clone）|
| **tgt_audio_path** | TTS 合成后的 mp3 路径（`tts/<segId>.mp3`）|
| **tgtDurMs** | TTS 实际产出时长（ms）|
| **align decision** | align 阶段对每段的处理策略（fit/sola/gap-borrow/video-slow/overflow）|
| **flag** | 段级质量标（green=完美 / yellow=可接受 / red=必须人工）|
| **needs_reclone** | 角色样本不足 10s 的标记 |
| **emotion** | 7 个原始值（happy/sad/angry/fear/disgust/surprise/neutral） |
| **voice_id** | MiniMax 服务端音色 id（克隆后 7 天有效）|
| **system voice** | MiniMax 平台自带音色（永久有效）|
