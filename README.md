# DramaPrime · 短剧 AI 译制桌面工作站

> 2026 年中国 AI 短剧出海的端到端译制工具。
>
> 输入：中文 AI 短剧成片  →  输出：任意目标语种译制版（语音 + 字幕）

- **版本**：v0.5（`package.json` = 0.5.0，2026-07-01）
- **状态**：14-stage 流水线全链路真跑；demucs 人声分离 / LLM 视觉辅助分轨 / 保留原音预处理 / 导演工作台均已落地
- **平台**：Windows 10+ / macOS 12+，桌面端
- **文档速览**：[产品定义 PRD](./docs/PRD.md) · [技术设计 TDD](./docs/TDD.md) · [v0.5 工程总结](./docs/TECH-OVERVIEW-v0.5.md) · [端到端 Workflow](./docs/WORKFLOW.md)

---

## 快速开始

### 环境

| 工具 | 版本要求 | 备注 |
| :-- | :-- | :-- |
| Node | ≥ 20（已用 22 验证） | electron-vite + better-sqlite3 |
| pnpm | ≥ 9 | `npm i -g pnpm` 安装 |
| Python | 3.11 | demucs 依赖；v0.6 会打成 standalone binary 内嵌 |
| demucs | `pip install demucs` | `htdemucs_ft` 模型首次运行会下载 |

### 启动开发环境

```bash
# 1. 安装依赖
pnpm install

# 2. 启动 desktop（HMR 完整，Renderer / Preload / Main 都热重载）
pnpm dev
```

第一次启动会弹出一个 1440×900 的 Electron 窗口，里面看到：

- 左侧导航：**项目 / 工作台 / 音色库 / 设置**
- 项目列表页空白 + 「新建项目」按钮
- 新建项目 → 选源视频 → 进入 **Workbench**，内含 4 个 tab：
  - **预处理** — 在时间轴上刷选"保留原音"片段（v0.5 新增）
  - **工作流** — 14 stage 状态机进度视图，点 ▶ 开始
  - **工作台** — 三段式导演工作台（角色 / segment / 详情，可试听可重合成）
  - **对齐** — 时长对齐策略可视化

### 打包桌面发行版

```bash
# 编译所有 workspace（含类型 dist 同步）
pnpm build

# 当前平台打包
pnpm dist

# 仅打 Mac（universal dmg）
pnpm dist:mac

# 仅打 Win（nsis + portable）
pnpm dist:win
```

打包前请准备好：

1. macOS 签名证书（Apple Developer ID）+ 公证 App-specific password
2. Windows EV Code Signing 证书
3. `binaries/ffmpeg/<os-arch>/` 下放对应平台的 ffmpeg / ffprobe 静态二进制（参见 [RUNBOOK](./RUNBOOK.md)）
4. demucs 目前仍需用户机器上 `pip install demucs`；v0.6 会用 PyInstaller 打进 `binaries/demucs/`

---

## 目录结构

```
.
├── apps/
│   └── desktop/                       # Electron 应用主体
│       └── src/
│           ├── main/                  # Node 主进程
│           │   ├── stages/            # 14 个 pipeline stage 真实实现
│           │   ├── ipc/               # IPC handler（project/segment/pipeline/system 等）
│           │   ├── orchestrator/      # 流水线调度
│           │   ├── storage/           # SQLite + better-sqlite3
│           │   ├── ffmpeg/            # ffmpeg/demucs 二进制定位 + spawn helper
│           │   ├── providers/         # 真实 provider 注入容器
│           │   └── migrations/        # SQLite 迁移 SQL
│           ├── preload/               # IPC bridge → renderer
│           └── renderer/              # React + Vite + Tailwind
├── packages/
│   ├── core-types/                    # 共享 TS 类型 + IPC ApiSurface + 语言表
│   ├── pipeline-core/                 # Stage 抽象 + Orchestrator + mock stages
│   ├── align-engine/                  # 5 级时长对齐 planner（纯函数）
│   ├── subtitle/                      # ASS V4+ / SRT 渲染器
│   ├── provider-MiniMax/              # MiniMax M3 / Speech-2.8 / Voice Clone / Vision 客户端
│   └── provider-volcengine/           # 火山豆包 ASR WebSocket 客户端
├── sidecar/                           # Python 子进程占位（v0.6 打 demucs standalone 后使用）
├── binaries/                          # 随包二进制（ffmpeg / demucs / sidecar 产物）
└── docs/                              # PRD / TDD / TECH-OVERVIEW-v0.5 / WORKFLOW / TECHNICAL-GUIDE
```

详细架构与文件索引见 [`docs/TECH-OVERVIEW-v0.5.md`](./docs/TECH-OVERVIEW-v0.5.md) §1、§6。

---

## v0.5 状态一览

| 模块 | 状态 | 备注 |
| :-- | :-: | :-- |
| Electron 三层架构 | ✅ | Main / Preload / Renderer，sandbox 安全配置 |
| IPC 类型契约 | ✅ | `ApiSurface` 强类型，含 v0.5 3 个 `project:*` 新通道 |
| SQLite 持久化 | ✅ | migration 0001 初始 + 0002 加 TTS snapshot / user override / thumb |
| Pipeline 14-stage 状态机 | ✅ | 全链路真跑；进度推送 / 断点续跑 / 依赖图调度 |
| 火山豆包 ASR | ✅ | WebSocket + speaker / gender / emotion / word-level 时间戳 |
| ASR 句段细分 | ✅ | `refineUtterances` 按标点+长度切，防字幕"一大段挂屏" |
| demucs 人声分离 | ✅ | `htdemucs_ft` 分离 vocals / accompaniment；accompaniment 二次降噪 |
| LLM Vision 视觉辅助分轨 | ✅ | 兄弟脸辨识，MiniMax-M3 多模态 + 全 segment 送图 |
| MiniMax Voice Clone | ✅ | 三步走（upload → clone → voice_id）+ 短样本循环复制 |
| MiniMax TTS + emotion | ✅ | 情绪映射（surprise→surprised 等）+ 2013 兜底 + 音学参数调优 |
| LLM 翻译 + idx 严格映射 | ✅ | MiniMax-M3 批量翻译 + 重译压缩循环 |
| 5 级时长对齐 | ✅ | fit / speed / SOLA / gap-borrow / video-slow / overflow |
| ASS V4+ 双语字幕 + SRT | ✅ | `packages/subtitle` 独立包 |
| ffmpeg 混音渲染 | ✅ | filter_complex + amix normalize=0 + 60s watchdog 防卡死 |
| 保留原音预处理（v0.5） | ✅ | 时间轴刷子 + gate&refill filter graph + 只失效 2 stage |
| Workstation 导演工作台 | ✅ | 角色 / segment / 详情三段式 + 单段重合成 |
| 系统音色回退轮转 | ✅ | 男女各 6 个池子，按 character 序号 modulo |
| demucs standalone 打包 | ⏳ | v0.6：PyInstaller 打 binary，去掉 `pip install` 依赖 |
| 跨集音色资产库 | ⏳ | v0.6：同剧多集共享 voice_id，累积样本到 30s+ |
| 真 video-slow filter | ⏳ | v0.6：ffmpeg setpts 切片，让 align 的 video-slow 策略落地画面 |

`✅` 已跑通 / `⏳` 待实现（详细路线见 TECH-OVERVIEW §5）

---

## v0.5 亮点速览

> 每一项都是"从踩坑到落地"的浓缩，深挖章节号见 [TECH-OVERVIEW-v0.5](./docs/TECH-OVERVIEW-v0.5.md)

- **demucs 真分离人声**（§3.1）— 替代 v0.3 的"原音轨 ×0.18 压低"兜底，vocals 拆干净、accompaniment 保住 BGM/音效，不再有中文人声 mumble 残留。
- **LLM Vision 拆兄弟脸**（§3.3）— 火山 speaker diarization 分不开同性别相似音色时，用 MiniMax-M3 多模态看**所有** segment 代表帧，按发色/发型/服装拆 sub-speaker。
- **克隆样本循环复制**（§3.4）— MiniMax 硬性要求 ≥10s；短剧配角常常不够。既不能降门槛（服务端拒收）也不能补静音（音色发闷）——按 character 单独裁 segment + 100ms 停顿 concat 到 10.5s+。
- **emotion 全链路映射**（§3.5）— 火山输出 `surprise/fear/disgust` ≠ MiniMax 需要 `surprised/fearful/disgusted`；错传一个 2013 就整句 TTS 静音。加白名单映射 + intensity/speed/vol/pitch 情绪饱满度表。
- **Workstation 导演工作台**（§3.9）— 摆脱"改情绪靠听感、查 DB 靠 sqlite3"。角色网格 → segment 表 → 详情区（3 路音频对比 + 参数可编辑 + 单段重合成，无需重跑 mix-render）。
- **保留原音预处理面板**（§3.10）— v0.5 主线新增。时间轴刷子画段 → 命中 segment 从 mix 剔除 → 用源视频完整音轨（BGM+音效+人声）回填 + 不烧字幕。配合 `app://` protocol 自实现 Range Request 让视频 seek 能工作。改一次 range 只失效 `subtitle-burn` + `mix-render`，30 秒看新片。

---

## 文档与代码的关系

- **PRD**（`docs/PRD.md`）— 为什么做、做给谁、做什么、不做什么。
- **TDD**（`docs/TDD.md`）— 18 章工程细节：ApiSurface 契约、SQLite DDL、状态机、错误模型。
- **TECH-OVERVIEW-v0.5**（`docs/TECH-OVERVIEW-v0.5.md`）— **已落地实现 + 经验值 + 坑**，含关键决策的方案演进、调参手册、FIX 编号日志。
- **WORKFLOW**（`docs/WORKFLOW.md`）— 从"用户点开始"到"mp4 落盘"的 14 阶段流水解释，适合新人快速建立心智模型。
- **TECHNICAL-GUIDE**（`docs/TECHNICAL-GUIDE.md`）— 面向工程实践的技术指南。
- **RUNBOOK**（`RUNBOOK.md`）— 打包、签名、公证、二进制准备等运维步骤。

新协作者建议路径：

1. **建立心智模型** — 读 `docs/WORKFLOW.md` §1（30 秒极简版 + 14 阶段图）
2. **理解决策由来** — 读 `docs/TECH-OVERVIEW-v0.5.md` §3（关键技术决策）里跟你要改的模块相关的小节
3. **对应到代码** — TECH-OVERVIEW §6 有关键文件索引，直接跳
4. **改动流程** — 类型改 `packages/core-types/`（IPC 契约在 `api.ts`）→ 主进程改 `apps/desktop/src/main/`（stages / ipc / storage）→ UI 改 `apps/desktop/src/renderer/src/`
5. **联调** — `pnpm dev`，Electron DevTools + main 进程日志双开

---

## 故障排查

- **better-sqlite3 / keytar 装不上** — 这两个是 native 模块，跨 Electron 版本需要 rebuild。`pnpm install` 后跑 `pnpm --filter @dramaprime/desktop exec electron-rebuild`。
- **macOS 启动报 "App is damaged"** — 未签名 dev build 的预期表现。`xattr -cr <path-to-app>` 临时绕过。
- **Renderer 看不到进度** — 检查 DevTools Console；常见原因是 `preload` 没正确 build → 重启 `pnpm dev`。
- **demix stage 显示 skip** — 用户机器没装 demucs 或 `htdemucs_ft` 模型没下载完；下游会用源音轨兜底，但中文人声会有残留。装 `pip install demucs` 后重跑该 stage。
- **mix-render 卡住不出文件** — 60s watchdog 会自动 kill；若频繁触发，检查 filter graph 是否有 `apad` 缺 `whole_dur`（见 TECH-OVERVIEW §3.8）。
- **预处理 tab 视频拖不动进度条** — `app://` protocol 的 Range Request 必须自己实现，若返回 200 而非 206 就会 `PIPELINE_ERROR_DECODE`。检查 `apps/desktop/src/main/index.ts` 的 handler。
- **视觉拆分把两个人合成一组** — LLM Vision 判定倾向"同一人"避假阳性，若真的看错可以在 Workstation 手动调 character 归属；网络故障时会保持原分组不炸。

---

## License

私有项目；许可证待定。
