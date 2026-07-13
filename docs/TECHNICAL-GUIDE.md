# DramaPrime · 技术说明书

> **版本**：v0.5（与代码同步）
> **日期**：2026-07-13（按当前代码同步）
> **目标读者**：新加入的开发者 / 二次开发
>
> 端到端工作流见 [`WORKFLOW.md`](./WORKFLOW.md)；产品需求见 [`PRD.md`](./PRD.md)；完整技术设计（含 IPC schema / SQLite DDL）见 [`TDD.md`](./TDD.md)。
>
> 这份文档讲清楚「代码怎么组织、怎么动手改、常见坑」。

---

## 1. 技术栈

| 层 | 选型 | 为什么 |
|:--|:--|:--|
| 桌面壳 | Electron 32 | 跨 Win/macOS 一次写；Renderer 严格沙箱 |
| Renderer | React 18 + Vite + Tailwind + Zustand | 主流 + HMR 快 |
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
| 本地资源桥 | 自定义 `app://` 协议 | Renderer 沙箱下安全读源视频 / 缩略图（支持 Range Request）|

---

## 2. 仓库结构

```
video-translate-new/
├── apps/desktop/                  ← Electron 应用
│   ├── electron-builder.yml       ← 打包配置
│   ├── electron.vite.config.ts     ← 编译配置
│   ├── src/
│   │   ├── main/                  ← Node 进程（IPC handler + pipeline + provider）
│   │   │   ├── stages/            ← stage 实现（真实 / disabled / mock 混合）
│   │   │   ├── providers/         ← 4 个 provider 注册
│   │   │   ├── orchestrator/      ← stage 注册 + 持久化
│   │   │   ├── storage/           ← SQLite + 迁移
│   │   │   ├── ipc/               ← 8 个 domain（30+ channel）handler
│   │   │   ├── keystore/          ← 系统 keychain 封装
│   │   │   ├── ffmpeg/            ← 抽帧 / loudnorm 封装
│   │   │   └── index.ts            ← main 入口 + app:// 协议
│   │   ├── preload/               ← contextBridge 暴露的 API（CJS）
│   │   └── renderer/               ← React UI
│   │       ├── pages/              ← ProjectList / Workbench / Voices / Settings
│   │       ├── components/         ← Workstation / PreprocessPanel / AlignPanel / Toast / ...
│   │       └── stores/             ← 全局 zustand-like store
│   └── release/                   ← 打包产物（gitignore）
├── packages/                       ← 纯逻辑包（无 Electron 依赖）
│   ├── pipeline-core/             ← Orchestrator + 14 stage mock 基线
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

`contextBridge` + `ipcRenderer.invoke` 桥接 renderer ↔ main。所有 channel 类型契约集中在
`packages/core-types/src/api.ts` 的 `ApiSurface`，preload/handler/renderer **三端共享类型**。

8 个 domain（详见 TDD.md §4）：
- `system:*` 5 个（ready / select-file / open-in-explorer / notify / read-file-as-data-url）
- `project:*` 9 个（create / list / get / delete / duplicate / import / export
  · **v0.5 新增**：set-original-audio-ranges / register-source-preview / get-preprocess-meta）
- `pipeline:*` 5 个（start / pause / retry-stage / reset-all / status）
- `segment:*` 5 个（list / update / set-use-original-audio / tts-regenerate / assets / resynth）
- `character:*` 4 个（list / rename / reclone / set-use-original-audio / reclone-extended）
- `voice:*` 3 个（list / rename / delete）
- `keystore:*` 3 个（get / set / test）
- `batch:*` 3 个（enqueue / status / cancel）

**事件推送**（main → renderer）：
- `event:pipeline:progress`
- `event:pipeline:stage-done`
- `event:pipeline:error`
- `event:pipeline:finished`

### 3.3.1 `app://` 本地资源协议（v0.5 新增）

Renderer 严格沙箱（`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`），
不能直接访问文件系统。所有需要在 Renderer 播放/显示的本地资源都走自定义 `app://` 协议：

```
URL 格式: app://local/<绝对路径>
  host = 'local'（固定；standard scheme 需要合法 host 名）
  pathname = encodeURIComponent 逐段编码的绝对路径
```

**Scheme 特权**（必须在 `app.whenReady` 之前调用，否则 `<video>` 无法 seek）：

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,           // 让 URL 走标准解析规则
    secure: true,             // 同 origin 可访问
    supportFetchAPI: true,    // fetch() 可用
    stream: true,             // ★ 视频 Range Request 必需
    corsEnabled: true,
  },
}])
```

**安全白名单**（`apps/desktop/src/main/index.ts`）：

```
ALLOWED_ROOTS          = [<userData>/projects, <userData>/cache]  // 常驻
allowedSingleFiles     = Set<absPath>                              // 临时单文件
```

`allowedSingleFiles` 用于"预处理 tab 播放源视频"——每次切项目 clear + add 一个绝对路径，
不开放整个 fs。缩略图和其他项目产物走 `ALLOWED_ROOTS`。

**Range Request 手动实现**：`protocol.handle('app', …)` 解析请求头的 `Range: bytes=X-Y`，
用 `fs.createReadStream({start, end})` 返回 `206 Partial Content` + `Content-Range` +
`Accept-Ranges: bytes`。不用 `net.fetch(file://…)` —— 那个不透传 Range，视频播几秒
必炸 `PIPELINE_ERROR_DECODE`（详见 6.6 规范）。

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
| electron | 32 | 桌面壳（Chromium 128+，`net.fetch` / `protocol.handle` 现代 API） |
| better-sqlite3 | 数据库 | native module，需 electron-rebuild |
| keytar | 密钥 | 同上 |
| @ffmpeg-installer/ffmpeg | 抽帧 / 转码 | 自动选平台 binary |
| pino | 日志 | 多 stream 输出 |
| ws | 火山 ASR WebSocket | 真实 Provider 使用；当前 IPC 尚未接入 Zod 等 runtime schema 校验 |
| @dramaprime/core-types | 共享类型 | pipeline-core / desktop 都引 |
| @dramaprime/pipeline-core | 14 stage mock | 离线跑通 UI |
| @dramaprime/align-engine | 5 级对齐策略 | 纯逻辑包；自动化测试待补 |
| @dramaprime/subtitle | ASS / SRT | 纯逻辑包；自动化测试待补 |
| @dramaprime/provider-MiniMax | M3 + TTS + clone | 国内 MiniMax |
| @dramaprime/provider-volcengine | 豆包 ASR | 国内火山引擎 |
| electron-updater | 自动更新依赖 | 仅安装依赖，Main 尚未接入检查 / 下载 / 安装流程 |

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

**例外：ProjectConfig 里加业务字段不需要 migration** —— `projects.config_json` 是整段 JSON
存储，`ProjectRepo.get` 用 `JSON.parse` 拿到对象，老 project 缺字段时 renderer 用 `??` 兜底默认值
即可。v0.5 的 `originalAudioRanges` 就是走这个路径加的。

### 6.6 改 `app://` 协议 handler 必须重视 Range Request + host 合法性

`apps/desktop/src/main/index.ts` 的 `protocol.handle('app', ...)` 是所有本地资源出口。改这里前
必读三条铁律：

**铁律 1：`<video>` 走 `app://` 必须显式声明 `stream: true` privilege**
在 `app.whenReady` 之前调 `protocol.registerSchemesAsPrivileged`。忘了这个，视频请求会被 Chromium
拒绝或挂起（v0.5 早期踩过：首次实现时用了默认 privilege，视频加载不出来）。

**铁律 2：URL 必须有合法 host**
声明 `standard: true` 后 Chromium 会校验 host 名合法性。用固定的 `local` 当 host，绝对路径全部
塞到 pathname，且用 `encodeURIComponent` 处理中文/空格。别用 `app://source/...` / `app://thumb/...`
这种自造 host —— Chromium 会拒收。

**铁律 3：Range Request 必须自己实现，不能用 `net.fetch(file://...)` 兜底**
Electron 的 `net.fetch` 遇到 `file://` 会返回整个文件，**不透传** Range 头。视频初始能播几秒（第一段
刚好从 0 开始对齐），一 seek 或者缓冲后续段 → Chromium 拿到偏移错误的字节 → 音频包解码失败
`PIPELINE_ERROR_DECODE`。

正确做法：解析 `Range: bytes=X-Y`，用 `fs.createReadStream({start, end})` +
`Readable.toWeb` 桥到 Web ReadableStream，返回 `206 Partial Content` + `Content-Range` +
`Content-Length` + `Accept-Ranges: bytes`。无 Range 请求也必须回 `Accept-Ranges: bytes` 告知
Chromium 以后可以 seek。

**加新资源类型时**：`mimeOf()` 是 MIME 映射白名单，加视频/音频/图片扩展名要在这里注册；不在里面的
文件回 `application/octet-stream`，`<video>` 可能拒播。

### 6.7 语种工程参数只维护一份

`packages/core-types/src/languages.ts` 的 `LANGUAGES` / `LANG_MAP` 是 40 语种唯一主数据源。UI 下拉、翻译 prompt、align 压缩重译都直接读取其中的 `zhName`、`kFactor`、`regionNeutralRule`；不要在 stage 内再建 `K_TABLE` / `LANG_LABEL` / `REGION_NEUTRAL`。新增或校准语种时只改主表，并跑 `pnpm typecheck`。

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

> 当前仓库只有 `typecheck` 是有效的自动化质量门禁：根 `lint` 命令找不到任何 workspace lint script，且尚无 `test` script。下面把未接入项明确标成待办，避免命令表造成“已覆盖”的误解。

| 项 | 工具 / 状态 |
|:--|:--|
| 类型检查 | `pnpm typecheck` |
| Lint | ⏳ 待接入 ESLint/Biome 与各 workspace `lint` script |
| 单元 / 集成测试 | ⏳ 待接入 Vitest；当前没有 `pnpm test` |
| 打包（mac + win） | `./build.sh` |
| 产物路径 | `apps/desktop/release/DramaPrime-*.dmg` / `*.exe` |
| 端到端冒烟 | 打开新建项目 → 选短片 → ▶ 开始 → 等 5 分钟 → 看 `out.mp4` |
| 版本号 | 改 `package.json` 的 `version` + `apps/desktop/package.json` 同步 |
| 自动更新 | ⏳ `electron-updater` 尚未接入 Main，当前通过重新下载安装包升级 |

---

## 10. 相关文档

| 文档 | 内容 |
|:--|:--|
| [`WORKFLOW.md`](./WORKFLOW.md) | 端到端工作流 + 14 stage 流程图 + 参数表 |
| [`PRD.md`](./PRD.md) | 产品需求 + D1-D13 决策 + 风险 + Roadmap |
| [`TDD.md`](./TDD.md) | 完整技术设计：IPC schema / SQLite DDL / Provider 接口 / 错误模型 |
| [`TECH-OVERVIEW-v0.5.md`](./TECH-OVERVIEW-v0.5.md) | 已落地实现的工程总结（各技术决策 + 修复日志）|
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
| **originalAudioRange** | v0.5 用户在"预处理 tab"手画的保留原音时间段 `{id, startMs, endMs, note?}` |
| **gate + refill** | v0.5 mix-render 实现 range 语义的 filter graph 模式：mix 层 volume=0 静音 + [0:a] 抽片段回填 |

---

## 12. 保留原音功能（v0.5 端到端参考）

> 该功能横跨 UI / IPC / DB / Filter Graph 四层，是个"小而完整"的样板。改这块前必读本节，避免踩坑。

### 12.1 用户视角

- 进 Workbench → **预处理** tab（v0.5 新增，排在"工作流"tab 前面）
- 上部：HTML5 `<video>` 播源视频；右侧：项目/视频统计卡
- 中部：工具栏（选择/刷子 · 撤销 · 帧对齐 · 帧号 · 时间显示）
- 时间轴：5 张 preprocess 缩略图铺底 + range 琥珀色块 + 两端拖拽把手 + 游标 + hover 时间提示
- 底部：片段列表（内联可编辑起止时间 · 备注 · 单个删除 · 清空全部）

**结果**：range 内 = 完整源视频音轨（BGM + 音效 + 人声，"原汁原味"）+ 不显示字幕；
range 外 = 正常 TTS + 伴奏 + 译文字幕。

### 12.2 数据模型（无 schema 变更）

在 `ProjectConfig` 加：

```ts
// packages/core-types/src/domain.ts
export interface OriginalAudioRange {
  id: string
  startMs: number
  endMs: number
  note?: string
}
export interface ProjectConfig {
  // ...
  originalAudioRanges?: OriginalAudioRange[]
}
```

**为什么无需 migration**：`projects.config_json` 整段 JSON 存储，老 project 缺字段时 renderer
用 `??` 兜底空数组。

### 12.3 IPC 通道（3 个新 channel）

```ts
// packages/core-types/src/api.ts
'project:set-original-audio-ranges': (input: { id, ranges }) => Promise<void>
'project:register-source-preview':   (input: { id }) => Promise<{ url: string }>
'project:get-preprocess-meta':       (input: { id }) => Promise<{
  fps, width, height, durationMs, thumbnails: string[]  // 缩略图 app:// URLs
} | null>
```

Handler 见 `apps/desktop/src/main/ipc/project.ts`：
- `normalizeRanges()`：过滤 `start >= end` 脏数据 → 按 startMs 排序 → 相邻 100ms 内合并
- 落库后 `StageRepo.reset('subtitle-burn' | 'mix-render')` —— **只失效这两个**，不动 ASR/翻译/TTS/align
- `register-source-preview` 调 main 的 `registerSourcePreview()` 把源视频路径 clear+add 到 `allowedSingleFiles`

### 12.4 mix-render 的 gate + refill filter graph

**核心思想**：mix 层用 `volume` 的 `enable` 表达式在 range 时间段静音，再从 `[0:a]` 抽出对应片段
回填。range 内 segment **完全从 mix 中剔除**（不用 srcAudioPath —— 那个只有 vocals 不含 BGM）。

```
mix_pre    = 伴奏 + silence + TTS各段（原有逻辑）
mix_gated  = mix_pre 在所有 range 时间段 volume=0
orig_seg_i = [0:a] atrim range_i + asetpts + adelay 到原位置
outa       = mix_gated + orig_seg_1 + ... amix
```

关键 filter 片段：

```
[0:a]asplit=N[src0][src1]...           # 一份给 bg 兜底 / N 份给各 range
[mix_pre]volume=enable='between(t,S1,E1)+between(t,S2,E2)':volume=0[mix_gated]
[src_i]atrim=S:E,asetpts=PTS-STARTPTS,adelay=S_ms|S_ms,apad=whole_dur=Tms[orig_i]
[mix_gated][orig_0][orig_1]...amix=inputs=M:normalize=0[outa]
```

三个易踩的坑：
1. **`asetpts=PTS-STARTPTS` 必须加**：`atrim` 抽出的片段保留原时间戳（10s 抽出来 PTS 还是 10s），
   不复位的话 `adelay` 计算基准是原时间戳 → 位置翻倍
2. **`[0:a] asplit=N` 复用源音**：ffmpeg 不允许 filter pad 被多次消费。当 range 数 + 兜底 bg 用
   到源音时必须先 asplit
3. **enable 表达式用秒**：`between(t,S,E)` 里 t 是秒（不是 ms），必须转换

### 12.5 subtitle-burn 的 range 处理

`apps/desktop/src/main/stages/subtitle-stage.ts`：判定策略与 mix-render 保持一致（segment 中心时间
落在任一 range 内 → 整句 cue 跳过）。ASS/SRT 里就没有 range 内的字幕，UI 上"清清爽爽"。

### 12.6 失效追踪：只清 2 个 stage

**为什么不重跑整条 pipeline**：
- range 只影响音轨拼接 + 字幕生成
- 前面 ASR / 翻译 / TTS / align 完全不受影响（每一步都是本地几秒到几十秒的 ffmpeg，重跑 provider 阶段
  意味着几十秒到几分钟 + provider 成本）
- 用户体验：调 range → 30 秒左右看到新片；改一个 range 不用等 10 分钟

### 12.7 相关文件索引

| 文件 | 职责 |
|:--|:--|
| `packages/core-types/src/domain.ts` | `OriginalAudioRange` 接口 + `ProjectConfig.originalAudioRanges` |
| `packages/core-types/src/api.ts` | 3 个 project:* IPC 契约 |
| `apps/desktop/src/main/index.ts` | `app://` 协议 + `registerSourcePreview` + Range Request handler |
| `apps/desktop/src/main/ipc/project.ts` | 3 个 handler + `normalizeRanges` + 失效逻辑 |
| `apps/desktop/src/main/storage/project-repo.ts` | `setOriginalAudioRanges` read-modify-write config |
| `apps/desktop/src/main/stages/ffmpeg-stages.ts` | `segmentInOriginalRanges` + `buildAudioVideoFilterGraph` gate+refill |
| `apps/desktop/src/main/stages/subtitle-stage.ts` | range 内 cue 整句跳过 |
| `apps/desktop/src/renderer/src/components/PreprocessPanel.tsx` | 预处理 tab UI（video + 时间轴 + 刷子 + 列表 + TimeInput）|
| `apps/desktop/src/renderer/src/pages/Workbench.tsx` | Tab 结构（预处理 / 工作流 / 工作台 / 对齐）|
