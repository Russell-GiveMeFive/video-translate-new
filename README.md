# DramaPrime · 短剧 AI 译制桌面工作站

> 2026 年中国 AI 短剧出海的端到端译制工具。
>
> 输入：中文 AI 短剧成片  →  输出：任意目标语种译制版（语音 + 字幕）

- **状态**：v0.1 脚手架已就绪；14 步 pipeline 状态机用 **mock provider** 离线可跑
- **平台**：Windows 10+ / macOS 12+，桌面端
- **文档**：[`docs/PRD.md`](./docs/PRD.md) · [`docs/TDD.md`](./docs/TDD.md)

---

## 快速开始

### 环境

| 工具 | 版本要求 | 备注 |
| :-- | :-- | :-- |
| Node | ≥ 20（已用 22 验证） | electron-vite + better-sqlite3 |
| pnpm | ≥ 9 | `npm i -g pnpm` 安装 |
| Python | 3.11（v0.1 可选；sidecar 用） | 真实 ASR/Demucs/OCR 时需要 |

### 启动开发环境

```bash
# 1. 安装依赖
pnpm install

# 2. 启动 desktop（HMR 完整，Renderer / Preload / Main 都热重载）
pnpm dev
```

第一次启动会弹出一个 1440×900 的 Electron 窗口，里面看到：

- 左侧导航（项目 / 工作台 / 音色库 / 批量 / 设置）
- 项目列表页空白 + 「新建项目」按钮
- 新建后进入工作台，点 ▶ 开始可以看到 14 个 stage 依次跑过（mock provider，每步 0.5-3 秒）

### 打包桌面发行版

```bash
# 编译所有 workspace
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
3. `binaries/ffmpeg/<os-arch>/` 下放对应平台的 ffmpeg / ffprobe 静态二进制（参见 RUNBOOK）

---

## 目录结构

```
.
├── apps/
│   └── desktop/                Electron 应用主体
├── packages/
│   ├── core-types/             共享 TS 类型（ApiSurface / Stage / Provider 接口）
│   ├── pipeline-core/          Stage 抽象 + Orchestrator + 14 个 mock stages
│   ├── provider-MiniMax/       MiniMax M3 / Speech-2.8 / Voice Clone 客户端
│   ├── provider-volcengine/    火山豆包 ASR 客户端
│   └── align-engine/           时长对齐算法（待实现）
├── sidecar/                    Python 子进程（Demucs / OCR / Diarize；待实现）
├── binaries/                   随包二进制（ffmpeg / sidecar 产物）
└── docs/                       PRD / TDD / ADR
```

详见 [`docs/TDD.md`](./docs/TDD.md) §2。

---

## v0.1 已经能做什么 / 还不能做什么

| 模块 | v0.1 状态 | 备注 |
| :-- | :-: | :-- |
| Electron 三层架构 | ✅ | Main / Preload / Renderer，沙箱安全配置 |
| IPC 类型契约 | ✅ | `ApiSurface` 强类型，30+ 通道 |
| SQLite 持久化 | ✅ | 9 张表 + 1 view 全部建好，better-sqlite3 + 迁移 |
| Pipeline 14 stage 状态机 | ✅ | mock 跑通；进度推送 / 断点续跑 |
| Provider 抽象 | ✅ | MiniMax + 火山接口已封装；v0.1 用 mock |
| Keystore | ✅ | keytar 接 Keychain / DPAPI |
| UI 框架 | ✅ | React + Tailwind + Zustand，3 个主要页面 |
| 真实 MiniMax LLM/TTS 调用 | ⚙️ | client 写好但默认走 mock，加 key 后切换 |
| 真实火山 ASR 调用 | ⚙️ | stub，待对接官方文档具体 endpoint |
| Python sidecar（Demucs / OCR） | ⏳ | 未实现，v0.2 |
| ffmpeg 视频合成 | ⏳ | 未实现，v0.2 |
| 时长对齐 SOLA | ⏳ | 算法骨架在 TDD §10，未编码 |
| 字幕烧录 | ⏳ | 未实现 |

`✅` 跑通 / `⚙️` 代码已写、需要配置 / `⏳` 待实现

---

## 与文档的关系

- **PRD**（`docs/PRD.md`）：你为什么做这个产品、做给谁、做什么、不做什么。
- **TDD**（`docs/TDD.md`）：18 章工程细节，含 ApiSurface 类型契约、SQLite DDL、状态机、错误模型等。
- **本仓库代码**：TDD 的实现起点。

新功能上手顺序建议：
1. 读 PRD 对应 FR 编号
2. 看 TDD 中对应的章节
3. 在 `packages/core-types/src/` 加 / 改类型
4. 在 `apps/desktop/src/main/ipc/` 加 handler
5. 在 `apps/desktop/src/renderer/src/` 加 UI
6. 跑 `pnpm dev` 联调

---

## 故障排查

- **better-sqlite3 / keytar 装不上**：这两个是 native 模块，跨 Electron 版本需要 rebuild。`pnpm install` 后跑 `pnpm --filter @dramaprime/desktop exec electron-rebuild` 即可。
- **macOS 启动报 "App is damaged"**：未签名 dev build 的预期表现。`xattr -cr <path-to-app>` 临时绕过。
- **Renderer 看不到进度**：检查 DevTools Console；常见原因是 `preload` 没正确 build → 重启 `pnpm dev`。

---

## License

私有项目；许可证待定。
