# RUNBOOK · 开发与运维实战手册

> 给开发者 / 维护者用。日常运行、打包、故障排查、新功能上手的"How"。

---

## 1. 首次配环境

### macOS

```bash
# Node 20+ & pnpm
brew install node@20
npm i -g pnpm

# Python 3.11（可选：重建 bundled Demucs 或使用 system fallback）
brew install python@3.11

# 可选：开发环境没有对应平台 bundled binary 时，用 system demucs 兜底
python3.11 -m pip install demucs
```

### Windows

```powershell
# Node 20+ & pnpm
choco install nodejs-lts
npm i -g pnpm

# Python 3.11（可选：重建 bundled Demucs 或使用 system fallback）
choco install python --version=3.11

# 可选：开发环境没有对应平台 bundled binary 时，用 system demucs 兜底
python -m pip install demucs
```

### 安装依赖

```bash
pnpm install
```

ffmpeg / ffprobe 由 `@ffmpeg-installer` / `@ffprobe-installer` 随 `pnpm install` 提供，不再要求手工复制。Demucs 发行产物不进 Git：正式打包前运行 `packaging/demucs/build.sh` / `build.ps1`，或从 `Build Demucs Binary` workflow 下载对应平台 artifact 到 `binaries/demucs/<platform-arch>/`。

如果 `better-sqlite3` 或 `keytar` 编译失败：

```bash
# 重新针对当前 Electron 版本编译
pnpm --filter @dramaprime/desktop exec electron-rebuild
```

---

## 2. 日常开发

```bash
# 启动开发模式（HMR 完整）
pnpm dev

# 类型检查（CI 必跑）
pnpm typecheck

# 格式化
pnpm format

# 单独构建某个包
pnpm --filter @dramaprime/core-types build

# 清理一切
pnpm clean
```

### 添加新的 IPC 通道

1. 在 `packages/core-types/src/api.ts` 的 `ApiSurface` 加 `'<domain>:<action>': (...) => Promise<...>`
2. 如果需要事件推送，在 `packages/core-types/src/events.ts` 的 `EventMap` 加事件类型
3. 在 `apps/desktop/src/main/ipc/<domain>.ts` 加 handler；用 `handle('<channel>', async (payload) => {...})`
4. Renderer 端用 `await api.call('<channel>', payload)` 调用（会自动 throw 错误分支）

### 添加新的 Pipeline Stage

1. 在 `packages/core-types/src/domain.ts` 的 `StageName` 加新名字，并同步 `ALL_STAGES` 数组顺序
2. 在 `packages/pipeline-core/src/stages/` 加 `<stage>.ts`，实现 `Stage` 接口
3. 在 `packages/pipeline-core/src/stages/index.ts` 的 `makeMockStages()` 添入
4. Renderer Workbench 的 `STAGE_LABEL` 补中文名

---

## 3. 接入真实 Provider（v0.1 → v0.2）

### ✅ 已实现的真实 stage（v0.2）

| Stage | 用什么 | 状态 |
| :-- | :-- | :-- |
| preprocess | ffprobe + ffmpeg | ✓ 抽缩略图、读元数据 |
| asr-diarize | providers.asr (火山豆包流式 ASR, Seed-ASR 2.0) | ✓ 需 volcengine.app_id + access_token；含 speaker / gender / emotion |
| cluster | 本地按 speaker 聚类 | ✓ 真实落 SQLite characters |
| translate | MiniMax M3（Anthropic 兼容） | ✓ 需 MiniMax api_key |
| tts-synth | MiniMax Speech-2.8（T2A v2） | ✓ 需 MiniMax api_key |
| voice-clone | MiniMax 三步走（upload → clone → 7d 临时音色） | ✓ 需 MiniMax api_key |
| demix | system demucs 优先、bundled PyInstaller binary 兜底 | ✓ 缺两者时 skipped，并降级使用源音轨 |
| align | @dramaprime/align-engine 5 级级联 + rubberband / ffmpeg atempo | ✓ 真实化 (v0.3) |
| subtitle-burn | @dramaprime/subtitle ASS + SRT 生成（含中-英双语布局） | ✓ 真实化 (v0.4) |
| mix-render | ffmpeg filter_complex 拼 TTS 音频（自动用 .aligned.mp3）+ 原视频画面 + **可选 libass 烧字幕** | ✓ |

### ⏳ 仍是 mock 的 stage

| Stage | 真实化路径 |
| :-- | :-- |
| import-precheck | v0.5 接 sidecar PaddleOCR |
| shot-detect | v0.5 接 sidecar PySceneDetect |
| finalize | v0.5 工程包导出 |

`ocr-assist` 不属于 mock：VLM OCR 的实现代码仍在，但当前因画面文字误识别和内容审核问题在 stage 入口全局 `skipped`，实际沿用 ASR 切句。

### 时长对齐工程小贴士

- **rubberband CLI 是可选优化**：装了（`brew install rubberband`）会得到最佳音质；没装也能跑（自动回退到 ffmpeg atempo）
- align 决策可视化：项目工作台「对齐」tab 看每句的策略与偏差，红/黄/绿分别标识必须人工 / 可接受 / 完美
- align 失败不阻塞 mix-render：单句对齐失败会回退用未对齐 TTS，仅该句听感漂

### Provider 切换（v0.2 已自动化）

进设置页填 `MiniMax.api_key` → 保存 → 自动热切换：
- LLM / TTS / VoiceClone：mock → real（看 main 终端日志的 `providers refreshed`）
- ASR：填齐 `volcengine.app_id` + `volcengine.access_token` 后热切换到真实火山 Seed-ASR；缺 Key 时使用 mock

---

## 4. 打包发布

### macOS

```bash
# 配置环境变量（当前构建配置只使用签名；notarize 仍为 false）
export CSC_LINK="path/to/DeveloperIDCert.p12"
export CSC_KEY_PASSWORD="cert-password"

pnpm dist:mac
# 当前配置产物：apps/desktop/release/DramaPrime-0.5.0-arm64.dmg
```

### Windows

```powershell
# EV Code Signing 证书
$env:CSC_LINK="C:\path\to\ev-cert.pfx"
$env:CSC_KEY_PASSWORD="cert-password"

pnpm dist:win
# 当前配置产物：apps\desktop\release\DramaPrime-0.5.0-x64-Setup.exe
```

### 自动更新 feed

⏳ **尚未接入**。项目已安装 `electron-updater` 依赖，但 Main 进程没有检查、下载或安装更新的调用；当前版本仍需重新下载安装包升级。未来接入时再配置自托管 CDN 的 `latest-mac.yml` / `latest.yml` 与签名产物。

---

## 5. 日志 / 数据 / 缓存位置

| 内容 | macOS | Windows |
| :-- | :-- | :-- |
| 用户数据 | `~/Library/Application Support/DramaPrime/` | `%APPDATA%\DramaPrime\` |
| SQLite | `<userData>/projects.db` | `<userData>\projects.db` |
| 日志 | `~/Library/Logs/DramaPrime/` | `<userData>\logs\` |
| 项目工程产物 | `<userData>/projects/<id>/` | `<userData>\projects\<id>\` |
| 模型缓存 | `<userData>/cache/models/` | `<userData>\cache\models\` |

清理时可用应用「设置 → 缓存目录」（v0.2 提供 UI），或直接删除上述目录。

---

## 6. 常见问题（v0.1 实跑过的坑）

### Q: `pnpm dev` 窗口一片黑 / 白屏 / 显示不出 UI
A: 检查 main 终端，找 `[renderer]` 开头的行——我们已经把 Renderer 的 console / 错误转发到 main 终端，肉眼可见根因。常见原因：
- **preload 加载失败**（`ENOENT` / `Cannot use import statement outside a module`）→ 见下两条
- **CSP 阻断**（`Refused to execute inline script` / `Refused to evaluate string`）→ `renderer/index.html` 的 CSP 太严，需要 dev 模式放宽
- **window.api is undefined**（`Cannot read properties of undefined (reading 'invoke')`）→ 通常是 preload 没注入成功的下游表现

### Q: 报 `Unable to load preload script: ../out/preload/index.js` (ENOENT)
A: `electron-vite` 在 `type: "module"` 项目下默认输出 `index.mjs`；但我们 sandbox: true 的 preload 必须用 cjs。本仓库 `electron.vite.config.ts` 已配置 `formats: ['cjs']` + `fileName: 'index.cjs'`，main 进程也用 `preload/index.cjs`。**新加 preload 入口时记得保持 .cjs**。

### Q: 报 `SyntaxError: Cannot use import statement outside a module`（在 preload 加载阶段）
A: 同上——sandbox: true 的 preload **必须是 CommonJS**，不能用 ESM `import`。`electron-vite` 的 preload 段一定要 `formats: ['cjs']`。

### Q: 新建项目时点"选择"按钮没反应？
A: 检查 `system:select-file` 通道是否注册；在 main 进程日志（终端）里搜 `ipc.ok system:select-file`。

### Q: 14 个 stage 一直停在某一步？
A: v0.1 全用 mock，每步 0.5-3s 必出结果；若卡住请看 main 终端日志的 `stage` 字段；常见是被 abort 信号杀掉。

### Q: `Error: The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 128`
A: native module（`better-sqlite3` / `keytar`）的 prebuild ABI 与当前 Electron 用的 Node 不一致。修：
```bash
pnpm --filter @dramaprime/desktop exec electron-rebuild -f -w better-sqlite3 -w keytar
```
Electron 升级后或换机器后，都要重跑一次。

### Q: 启动报 `Unknown file extension ".ts" for .../packages/core-types/src/index.ts`
A: `externalizeDepsPlugin` 默认把所有 `dependencies` 排除在 vite bundle 之外，但 workspace 包入口指向 `.ts` 源文件，Node ESM 不能直接 import。修：在 `electron.vite.config.ts` 里 exclude workspace 包，让 vite bundle 进 main / preload。本仓库 `electron.vite.config.ts` 已配置；**新增 workspace 包时记得加进 `WORKSPACE_PKGS` 数组**。

### Q: 启动报 `Error: unable to determine transport target for "pino-pretty"`
A: 我们 v0.1 不用 `pino-pretty`（多了一个 worker thread + 200KB 依赖）。日志直接 multistream 双路写（文件 + stdout）。若你想要彩色 dev 日志，可以 `pnpm add -D pino-pretty` 再改 `apps/desktop/src/main/logger.ts`。

### Q: TS 报 `Output file '.../dist/index.d.ts' has not been built from source file '.../src/index.ts'` (TS6305)
A: 之前用 `composite: true + references` 的 monorepo TS 设置与"入口直接指向 src/ts"冲突。本仓库已统一去掉 composite，让 vite / electron-vite 处理跨包 import。**新增 workspace 包时 tsconfig 不要再加 `composite` / `references`**。

### Q: TS 报 `This member must have an 'override' modifier` (TS4114)
A: `noImplicitOverride` 严格模式下覆盖父类成员必须显式 `override`。直接给字段/方法加 `override` 关键字即可。

### Q: keytar / better-sqlite3 在新 Electron 版本下报错？
A: 见上面 ABI 不匹配条目。


---

## 7. 给新维护者的"上手 30 分钟"

1. 读 [`docs/PRD.md`](./docs/PRD.md) §1-3（5 分钟）→ 知道产品做什么
2. 读 [`docs/TDD.md`](./docs/TDD.md) §1, §6（10 分钟）→ 知道架构 + 状态机
3. `pnpm install && pnpm dev`（5 分钟）→ 跑起来
4. 在 UI 上「新建项目 → 选随便一个 mp4 → 开始」→ 看 14 步流转
5. 打开 `packages/pipeline-core/src/orchestrator.ts` → 看 Orchestrator 主循环
6. 打开 `apps/desktop/src/main/ipc/pipeline.ts` → 看 IPC ↔ Orchestrator 的桥接
7. 完
