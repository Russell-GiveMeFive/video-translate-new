# DramaPrime · 端到端工作流

> **版本**：v0.5（与代码同步）
> **日期**：2026-07-01
> **目标读者**：新加入的工程师 / 产品 / 客户
>
> 这份文档讲清楚「一段中文短剧输入后，DramaPrime 在内部都做了什么」。
> 完整产品定义见 [`PRD.md`](./PRD.md)；技术架构 / IPC 协议 / SQLite schema 见 [`TDD.md`](./TDD.md)。

---

## 0. 30 秒极简版

```
输入:  1 段 720p / 1080p 中文短剧 mp4
输出:  1 段译制 mp4（任意目标语种、原音被替、可选烧录新字幕）

技术:  14 阶段串行 pipeline，
       涉及 4 个外部 AI 服务（MiniMax M3 + MiniMax Speech-2.8 + 火山豆包 Seed-ASR + PyInstaller-demucs），
       本地一个 Electron 桌面壳子 + SQLite + 文件系统。
```

---

## 1. 14 阶段 Pipeline 总览

下图是从用户点「开始」到最终 mp4 落盘的完整流程。每个方块是一个 **stage**：

```
┌────────────── 用户操作 ──────────────┐
│ 创建项目 → 选源视频 → 选目标语种 →  选「有/无烧录中文字幕」  → ▶ 开始
└─────────────────────────────────────────┘
                  ↓
┌────────── [可选] 预处理 tab（v0.5 新增）─────────┐
│ 在时间轴上用刷子画"保留原音"片段：这些段最终用      │
│ 源视频完整音轨（BGM/音效/人声），且不显示字幕。    │
│ 可随时增删改，只影响 subtitle-burn + mix-render。 │
└────────────────────────────────────────────────┘
                  ↓
┌──────────────────── 14 阶段 pipeline（自动串行）────────────────────┐
│                                                                        │
│  ① preprocess          抽 metadata + 5 张缩略图                          │
│  ② import-precheck      硬字幕检测（v1.0 仅警告）                        │
│  ③ shot-detect          镜头切分（占位）                                  │
│  ④ demix                PyInstaller-demucs / system demucs                │
│  ⑤ asr-diarize          火山豆包 Seed-ASR（流式 + 说话人）              │
│  ⑥ ocr-assist           [可选] MiniMax M3 Vision 读原片烧录中文时间轴      │
│  ⑦ cluster             ASR utterances 按 speaker 聚类 → characters      │
│  ⑧ voice-clone          MiniMax voice_clone：每个角色选样 → 上传 → 复刻  │
│  ⑨ translate            MiniMax M3 batch 翻译（12 句/批）                │
│  ⑩ tts-synth            MiniMax Speech-2.8 逐句合成 + loudnorm 归一化    │
│  ⑪ align               SOLA 弹性变速，把 TTS 对齐原片时轴                 │
│  ⑫ subtitle-burn       生成 ASS / SRT，range 内跳过整句字幕（v0.5）      │
│  ⑬ mix-render           ffmpeg filter_complex 混音 + 烧字幕 + 输出 mp4  │
│                         range 内 gate + refill 用源音替换 TTS（v0.5）    │
│  ⑭ finalize            写 manifest.json（产物清单 + 成本 + 时长）        │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                  ↓
┌──────────────────── 产物 ────────────────────────────────────────────┐
│  apps/desktop/release/<projectId>/render/out.mp4       译制视频       │
│                                       /subs/out.ass    字幕文件        │
│                                       /tts/*.mp3       各句 TTS 音频    │
│                                       /stems/          人声/伴奏分离     │
│                                       /preprocess/     元数据 + 缩略图   │
│  projects.db                                              SQLite 数据库 │
└────────────────────────────────────────────────────────────────────────┘
```

每个 stage 都是 **异步的、可重试的、可独立失败的**。Stage 实现位于 `apps/desktop/src/main/stages/`。

---

## 2. 各阶段技术细节

> 详细实现见代码 + TDD.md；这里只讲**这个 stage 用什么模型、什么参数、什么时候会失败**。

### ② preprocess / ③ shot-detect

纯本地 ffmpeg 推理。`ffmpeg-installer` 包提供二进制，**不调任何 AI**。ffmpeg 抽 1 帧 + ffprobe 读时长 / 宽高 / fps，写 `preprocess/metadata.json`。

### ④ demix（人声分离）

| 选项 | 命令 | 模型 | 输出 |
|:--|:--|:--|:--|
| **优先** | `system demucs` (pip) | Facebook Demucs `htdemucs_ft` | 2 wav：vocals.wav / accompaniment.wav |
| **fallback** | `binaries/demucs/darwin-arm64/demucs` | 同上（PyInstaller 打包） | 同上 |

**耗时**：~30s/分钟视频。**失败** = `kind: 'skipped'`，下游用源音轨兜底（音量压低 15dB）。

### ⑤ asr-diarize（中文识别 + 说话人分离）

| 项 | 值 |
|:--|:--|
| Provider | 火山豆包（[火山引擎](https://www.volcengine.com)）|
| 模型 | Seed-ASR 2.0（流式 + 说话人）|
| 输入 | 16k mono PCM wav（demix 的 vocals.wav） |
| 输出 | utterances: `{ startMs, endMs, text, speakerId, gender, words[] }` |
| 用户填 | `volcengine.app_id` + `volcengine.access_token` |

**v0.4.12 坑**：
- 火山对**穿插英文歌词**返回 `startMs: -1`（卡拉 OK 词级时间戳）—— ASR 阶段已加脏数据过滤（`startMs < 0` 丢弃）
- 中长句（4 秒以上）会被 `splitByWords` 拆成多个 segment

### ⑥ ocr-assist（**可选**，用户创建项目时勾选）

| 项 | 值 |
|:--|:--|
| 何时跑 | `config.ocr.hasBurnedInSubtitles === true` |
| Provider | MiniMax M3 **Vision**（走 Anthropic 兼容 `/v1/messages`，传 image content block）|
| 抽帧 | 1.5 fps + 480px 宽（节省 token） |
| 全局超时 | 60s（防 VLM 卡住）|
| 并发 | 4 路 |
| 输出 | 把"中文出现/消失"时间区间重写 SQLite segments 表（**替换** ASR 切句）|
| 用户填 | MiniMax.api_key（复用 M3 key） |

**为什么需要**：ASR 切句节奏 ≠ 原片烧录字幕节奏，导致"1 段中文配 N 段译文"。OCR 用原片字幕时间轴强制对齐。

**v0.4.12 失败容错**：单帧 API error → 跳过整帧；前 10 帧全空 → 早退（视频无字幕）；60s 超时 → 走 ASR 兜底。

### ⑦ cluster（按说话人聚类 → 角色）

读 `asr-diarize` 输出的 utterances → 按 `speaker_id` 分组 → 给每个 speaker 创建 character 行。

**`needs_reclone` 标记**：角色样本 < 10s 自动走系统音色兜底 + 标 `needs_reclone=1`，让 v0.4.12 的"循环复制到 10.5s"逻辑生效。

### ⑧ voice-clone（音色复刻）

| 项 | 值 |
|:--|:--|
| Provider | MiniMax `/v1/voice_clone`（PyInstaller 包装的 binary 或系统 demucs 同理，这里是 system `clone` SDK）|
| 模型 | MiniMax 临时复刻音色（**7 天有效期**）|
| 样本 | 10-30s 干净人声，score = SNR×0.4 + 时长×0.3 + 背景音反向×0.3 |
| 不足 10s | 循环复制填充到 10.5s（v0.4.12 加的） |
| 角色入库 | 写 `characters.voice_id` + 写 `voice_assets` 跨项目库（v0.4.12 加的）|

**v0.4.12 音色库**：复刻成功后写到 `voice_assets` 表，UI 在「音色库」tab 可看、改名、移除（不移除实际 MiniMax 服务端）。

### ⑨ translate（LLM 翻译）

| 项 | 值 |
|:--|:--|
| Provider | MiniMax M3（Anthropic 兼容 `/v1/messages`）|
| 模型 | **MiniMax-M3** |
| 批量 | 12 句/批 |
| temperature | 0.6 |
| max_tokens | 2048 |
| thinking | **关闭**（节省延迟 + 成本） |
| 输出 | JSON `{ "<idx>": { text, est_dur } }` |

**防合并翻译**（v0.4.10 加）：
- 严格 1:1 prompt：禁止 M3 把相邻 3 句中文合并成 1 句长译文
- **后处理校验** `findDuplicateTranslations`：检测到 3 句 idx 拿到同一字符串 → 触发 `retranslateIndividually` 单句重译（断绝"合并"动机）
- 4 个并发实时检测、严格白名单校验 emotion 字段

**情绪映射**：M3 可能返回 7 个原始值（happy/sad/angry/fear/disgust/surprise/neutral），翻译层 **M3 收到的 emotion 是元数据**，但 TTS 合成由 TTS 引擎按 `emotion` 字段自动调速 / 调音高 / 调强度。

### ⑩ tts-synth（TTS 合成）

| 项 | 值 |
|:--|:--|
| Provider | MiniMax `/v1/t2a_v2` |
| 模型 | **speech-2.8-hd** |
| 字段 | voice_setting: speed/vol/pitch/emotion + voice_modify: pitch/intensity/timbre |
| 短句嘶吼 | `isShortShoutSegment()` 检测 ≤4 字 + ! → 走客户硬性 curl 参数：speed=0.6, vol=10, pitch=3, voice_modify={pitch:20, intensity:-40, timbre:-20}, emotion=angry, **不传 emotion_intensity**（避免与 voice_modify.intensity 互相干扰）|
| 后处理 | ffmpeg volume=NdB 归一化到 -18dBFS（按 mean_volume 实测补差），消除跨克隆音色响度差 |
| 防限流 | MiniMax RPM 限流（错误码 1002）→ 指数退避 500/1500/4500ms × 3 次 + 段间 throttle 200ms |

**v0.4.12 关键修复**：
- `emotion=neutral` 不在 MiniMax 枚举里（白名单只有 happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper），传了会报 2013 被降级去 emotion → 用户感知"情感参数失效"——**已删 neutral 映射**
- `voice_setting.pitch` 和 `voice_modify.*` 三个字段必须 `Math.round()`（MiniMax OpenAPI 写明 `type: integer`）

### ⑪ align（时长对齐）

| 阶段 | 策略 | 触发 |
|:--|:--|:--|
| 1 | **fit** | TTS 与原片槽位偏差 ≤ 100ms（toleranceMs） |
| 2 | **SOLA 弹性变速** | 偏差 5-30%，用 rubberband / ffmpeg atempo 变速不变调 |
| 3 | **gap-borrow** | TTS 长于槽位 + 前后有静音 → 借相邻 segment 的间隙 |
| 4 | **video-slow** | TTS 长于槽位 + 容忍内 → 视频局部慢放 ±5%（默认 on） |
| 5 | **overflow** | 全部失败 → 红标、等人工 |

**v0.4.5 起**：语音 TTS 时长若超 segment 槽位 → 视频慢放（±5%）。**v0.4.9 修复**：重复触发警告（fallback 仍能跑）。

### ⑫ subtitle-burn（字幕生成 + 烧录）

| 步骤 | 实现 |
|:--|:--|
| 1. 写 SRT | 标准格式（双语：原文+译文） |
| 2. 写 ASS | 用 ffmpeg ass 滤镜烧录（可选双语，原片中文字幕可能被叠加） |
| 3. wrap | `maxCharsPerLine=24` 自动折行（防止一句撑满两行） |
| 4. 位置 | `bottomMarginRatio=0.06`（距底 6% = 1080p 下 115px）— 避开 home indicator |
| 5. **v0.5 range 跳过** | 中心时间落在 `originalAudioRanges` 内的 segment，整句 cue 直接 skip |

### ⑬ mix-render（最终合成）

ffmpeg filter_complex 一次性合成：
- 视频画面：原片
- 主音轨：TTS 拼接（按 segment startMs 偏移）
- 背景音：`stems/accompaniment.wav`（demix 产物）或源音轨 -15dB 兜底
- 字幕：烧入 / 软字幕

**v0.5 保留原音 gate + refill**：
- range 命中的 segment 从 mix 剔除（不用 srcAudioPath —— 那个只有 vocals 缺 BGM）
- `mix_pre` 用 `volume=enable='between(t,S1,E1)+...':volume=0` 在 range 时间段静音
- 每个 range → `[0:a] atrim + asetpts=PTS-STARTPTS + adelay` 抽出源视频完整音轨的对应片段回填
- `mix_gated` + 所有 `orig_i` amix → `outa`

输出 `out.mp4`（h264 + aac + faststart）。

### ⑭ finalize

写 `manifest.json` 给后续 CLI 工具读：
- 产物路径 + 尺寸
- 总成本 + 各阶段成本拆分
- 总耗时 + 各 stage 耗时
- 各角色 voice_id 列表（用于跨项目复用）

---

## 3. 关键参数表

| 参数 | 位置 | 默认值 | 含义 |
|:--|:--|:--|:--|
| `maxCharsPerLine` | `subtitle/types.ts` | 24 | 单行字符上限（wrapCueText 折行） |
| `bottomMarginRatio` | `subtitle/types.ts` | 0.06 | 字幕距底比例（0.06 = 6%） |
| `silenceCutoffMs` | asr-cluster-stages.ts | 450 | 词间静音切句阈值（ms） |
| `toleranceMs` | ProjectConfig.align | 100 | align 容忍偏差（ms） |
| `videoSlowMaxRatio` | ProjectConfig.align | 0.05 | 视频慢放最大比例 ±5% |
| `vol` baseline | core-types DEFAULT_TTS_BASELINE | 1.5 | TTS 输出音量基准 |
| `pitch` 短句嘶吼 | tts-stage.ts | 3 + voice_modify.pitch=20 | 短句独立呼喊的高音特征 |
| `speed` 短句嘶吼 | tts-stage.ts | 0.6 | 拖长爆发感（0.5-2.0 范围下限附近）|
| `intensity` 短句嘶吼 | voice_modify | -40 | 声纹"刚劲"参数（负值更沉）|
| `timbre` 短句嘶吼 | voice_modify | -20 | 声纹"浑厚"参数（负值更厚）|
| VLM 抽帧 fps | vlm-ocr-stage.ts | 1.5 | 抽帧密度（1.5 fps 足够 0.5s 字幕） |
| VLM 全局超时 | vlm-ocr-stage.ts | 60000ms | 60s 超时走 ASR 兜底 |
| VLM 并发 | vlm-ocr-stage.ts | 4 | M3 VLM 并发请求数 |
| TTS 段间 throttle | tts-stage.ts | 200ms | 5 RPS（防 MiniMax RPM 限流） |

---

## 4. 数据流（详细）

```
源视频 mp4
  ↓ ffmpeg -i (preprocess)
metadata.json + 5 张缩略图
  ↓ ffmpeg -i (demix)
vocals.wav + accompaniment.wav
  ↓ ffmpeg -i (asr 输入)
PCM 16k mono
  ↓ 火山豆包 Seed-ASR
utterances[{ startMs, endMs, text, speakerId, words[] }]
  ↓ splitByWords (asr-cluster-stages)
cleaned segments
  ↓ [可选] M3 Vision 识别原片中文字幕时间轴
  ↓    ocr-assist
VLM 重写 segments 时间轴
  ↓ M3 LLM batch translate (translate-stage)
segments with tgt_text
  ↓ MiniMax Speech-2.8 逐句合成 (tts-stage)
tts/<segId>.mp3 + loudnorm 归一化
  ↓ align-stage SOLA 弹性变速
  ↓ subtitle-stage 生成 ASS
  ↓ mix-render ffmpeg filter_complex
out.mp4
```

---

## 5. 失败模式 + 兜底

| Stage | 失败模式 | 兜底 |
|:--|:--|:--|
| demix | demucs 没装 / 崩溃 | kind='skipped'，用源音轨 -15dB 兜底 |
| asr-diarize | 网络超时 | 整 batch 重试 1 次（retries=1）|
| ocr-assist | API 1006 限流 / 1026 内容敏感 | 单帧跳过 + 60s 全局超时 → ASR 兜底 |
| voice-clone | 样本 < 2.5s | kind='skipped'，走系统音色 |
| voice-clone | 样本 2.5-10s | 循环复制到 10.5s 再上传 |
| translate | M3 合并多句 | 1:1 prompt + 后处理去重校验 + 单句重译 |
| tts-synth | MiniMax 1002 限流 | 指数退避 500/1500/4500ms × 3 + 段间 200ms throttle |
| tts-synth | emotion=neutral 触发 2013 | 已删 neutral 映射（v0.4.12） |
| align | SOLA 拉不动 | 回退视频慢放（±5%） → 红标 overflow |
| subtitle-burn | 所有 segment 都被 range 覆盖 | `kind='skipped'`，不生成字幕（合成时 range 内本来就无字幕）|
| mix-render | 所有 segment 都被 range 覆盖 | 退化为"复制原视频画面 + 原音"（`args = ['-i', src]`），自动正确 |
| mix-render | ffmpeg 失败 | 60s watchdog abort + kind='failed' |

---

## 6. 关键文件路径

| 文件 | 说明 |
|:--|:--|
| `apps/desktop/src/main/stages/<stage>.ts` | 14 阶段真实实现 |
| `apps/desktop/src/main/providers/index.ts` | 4 个外部 Provider 注册（MiniMax LLM/TTS/Clone、volcengine ASR）|
| `apps/desktop/src/main/orchestrator/index.ts` | 14 阶段 stage 注册 + 持久化数据库 |
| `apps/desktop/src/main/index.ts` | app:// 协议 + Range Request + 白名单（v0.5）|
| `apps/desktop/src/main/ipc/project.ts` | v0.5 set-original-audio-ranges / register-source-preview / get-preprocess-meta |
| `apps/desktop/src/renderer/src/pages/Workbench.tsx` | 主页 + 4 tab（预处理 / 工作流 / 工作台 / 对齐）|
| `apps/desktop/src/renderer/src/components/PreprocessPanel.tsx` | v0.5 保留原音预处理面板 |
| `apps/desktop/src/renderer/src/components/Workstation.tsx` | 详情页（重合成单句）|
| `apps/desktop/src/renderer/src/pages/Voices.tsx` | 跨项目音色库（v0.4.12）|
| `apps/desktop/src/renderer/src/components/Toast.tsx` | 全局 toast + 系统气泡（v0.4.12）|
| `apps/desktop/src/main/storage/migrations/0001_init.sql` | SQLite schema |
| `apps/desktop/src/main/keystore/index.ts` | 密钥存 macOS keychain / Windows credential |
| `packages/align-engine/src/planner.ts` | 5 级对齐级联策略 |
| `packages/subtitle/src/ass.ts` | ASS 生成器（双语 / 烧录）|
| `packages/provider-MiniMax/src/tts.ts` | T2A v2 客户端（含 voice_modify / loudnorm）|
| `docs/PRD.md` | 产品需求 |
| `docs/TDD.md` | 技术设计（IPC / schema / Provider 详细）|

---

## 7. 端到端时延 + 成本

1 分钟视频：

| 阶段 | 耗时 | 成本 |
|:--|:--|:--|
| preprocess | 5s | 0 |
| demix | 30-90s | 0（本地） |
| asr-diarize | 20-30s | ¥0.5-1 |
| ocr-assist | 30-60s | ¥0.5-1.5（如果启用）|
| cluster | 5-15s | 0 |
| voice-clone | 30-60s/角色 | ¥0.5-2/角色 |
| translate | 10-20s | ¥0.5-1.5 |
| tts-synth | 60-120s | ¥2-4（HD 模型）|
| align | 5-10s | 0 |
| subtitle + render | 10-15s | 0 |
| **合计** | **3-5 分钟** | **¥4-10/分钟视频** |

（4 分钟短剧 1 集 6-8 个角色，估 ¥30-50/集）

---

## 8. 相关文档

- [`PRD.md`](./PRD.md) — 产品需求文档（含 D1-D13 决策、Roadmap、风险）
- [`TDD.md`](./TDD.md) — 技术设计（IPC、SQLite DDL、Provider 抽象、Stage 接口）
- [`TECHNICAL-GUIDE.md`](./TECHNICAL-GUIDE.md) — 代码组织 + 开发规范 + v0.5 保留原音端到端参考
- [`TECH-OVERVIEW-v0.5.md`](./TECH-OVERVIEW-v0.5.md) — 已落地实现总结（技术决策 + 修复日志）
- [`../RUNBOOK.md`](../RUNBOOK.md) — 部署 + 排错
