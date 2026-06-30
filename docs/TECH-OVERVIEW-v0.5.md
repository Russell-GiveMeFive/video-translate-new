# DramaPrime — 技术实现总览 v0.5

> 2026-06-08 · 译制流水线从骨架到真实流跑通后的工程总结
>
> 配套阅读：`PRD.md`（产品决策与场景）· `TDD.md`（技术设计文档）· 本文聚焦"**已落地实现 + 经验值 + 坑**"

---

## 1. 系统架构

### 1.1 monorepo 结构

```
video-translate-new/
├── apps/
│   └── desktop/                       # Electron 应用（main + preload + renderer）
│       └── src/
│           ├── main/                  # Node 主进程
│           │   ├── stages/            # 14 个 pipeline stage 实现
│           │   ├── ipc/               # IPC handler 注册
│           │   ├── orchestrator/      # 流水线调度
│           │   ├── storage/           # SQLite + better-sqlite3
│           │   ├── ffmpeg/            # ffmpeg/demucs 二进制定位 + spawn helper
│           │   ├── providers/         # 真实 provider 注入容器
│           │   └── migrations/        # SQLite migration SQL
│           ├── preload/               # IPC bridge → renderer
│           └── renderer/              # React + Vite + Tailwind
│               └── src/
│                   ├── pages/         # Workbench 主页
│                   ├── components/    # Workstation / AlignPanel
│                   └── api/           # IPC 调用包装
├── packages/                          # 复用包（pnpm workspace）
│   ├── core-types/                    # 类型契约 + IPC schema + 语言表
│   ├── pipeline-core/                 # Orchestrator + mock stages
│   ├── align-engine/                  # 时长对齐 planner（纯函数）
│   ├── subtitle/                      # ASS/SRT 渲染器
│   ├── provider-MiniMax/              # LLM/TTS/Clone API 客户端
│   └── provider-volcengine/           # 火山 ASR WebSocket 客户端
├── binaries/                          # 自带 ffmpeg/demucs（asarUnpack）
└── docs/
```

### 1.2 进程模型

| 进程 | 职责 |
|------|------|
| **Electron main** | 调度流水线、调用所有外部服务（MiniMax/火山）、SQLite 写入、spawn ffmpeg/demucs |
| **Electron renderer** | React UI、不直接访问文件系统、通过 IPC 拿数据 |
| **Electron preload** | 暴露受限 IPC bridge 给 renderer（sandbox 模式） |
| **ffmpeg / demucs 子进程** | 临时 spawn，处理音视频；通过 stdout/stderr 监听进度 |

### 1.3 数据存储

- **SQLite**（`~/Library/Application Support/DramaPrime/projects.db`）：项目、segments、characters、stages、costs
- **项目工作目录**（`~/Library/Application Support/DramaPrime/projects/<projectId>/`）：
  ```
  ├── preprocess/      # metadata.json + 5 张总体缩略图
  ├── stems/           # demucs 产物: vocals.wav + accompaniment.wav
  │                    # + ASR 用的 vocals-asr.wav (16k mono PCM)
  ├── thumbs/          # 每个 segment 一张代表帧 (320px JPG)
  ├── voices/          # 每个 character 的克隆样本 mp3
  │   └── _split-thumbs/  # 视觉拆分用临时缩略图
  ├── segment-audio/   # 单 segment 原音裁切（工作台试听用）
  ├── tts/             # 每句 TTS 产物 mp3
  ├── subs/            # out.ass + out.srt
  └── render/          # 最终 out.mp4
  ```

---

## 2. 流水线设计：14 个 stages

```
1. preprocess        — ffprobe 抽元数据 + 5 张总缩略图
2. import-precheck   — (mock，v1.0 不做)
3. shot-detect       — (mock，v1.0 不做)
4. demix             — demucs htdemucs_ft 分离 vocals/accompaniment
5. asr-diarize       — 火山 Streaming ASR + 句段细分
6. ocr-assist        — 实际占用：每 segment 抽代表帧 (工作台用)
7. cluster           — 按 speaker_id 分组 + LLM Vision 拆分 + 建 character
8. voice-clone       — MiniMax Voice Clone 三步走 (upload→clone→voice_id)
9. translate         — MiniMax-M3 批量翻译 + idx 严格映射
10. tts-synth        — MiniMax Speech-2.8-hd 合成
11. align            — 重译压缩循环 + SOLA 弹性变速
12. subtitle-burn    — 生成 ASS V4+ (双语) + SRT
13. mix-render       — ffmpeg filter_complex 混音 + 烧字幕
14. finalize         — 工程包导出 (manifest.json)
```

### 2.1 stage 调度规则

- 每个 stage 声明 `inputsFrom: StageName[]` 表达依赖
- `blocking: false` 的失败不阻塞下游（demix 没装就 skip 用源音轨兜底）
- `retries` 自动重试次数（网络类错误用）
- `kind` 决定调度位置：`utility`（ffmpeg）/ `provider`（外部 API）/ `main`（计算）/ `sidecar`（Python 进程）

### 2.2 关键依赖图

```
preprocess ──┐
             ├─→ demix (htdemucs_ft, 30-90s)
             │       └─→ asr-diarize (火山 WebSocket, 平均 35s)
             │              └─→ ocr-assist=thumb-extract (并行)
             │              └─→ cluster (含 LLM Vision 拆分)
             │                     └─→ voice-clone (MiniMax, 5-10s/角色)
             │                     └─→ translate (MiniMax-M3, 15-20s)
             │                            └─→ tts-synth (MiniMax-2.8-hd, ~20s)
             │                                   └─→ align (SOLA + 重译循环)
             │                                          └─→ subtitle-burn
             └─→ mix-render (含 subtitle filter, ~10s) ←┘
                    └─→ finalize
```

---

## 3. 关键技术决策

### 3.1 demix：人声分离的工程化

**问题**：译制片需要保留 BGM/音效但替换人声。如果不分离，TTS 直接覆盖原音轨会丢失所有背景音；如果叠加原音轨，原中文人声会作为 mumble 残留。

**方案演进**：
- **v0.3**：mix-render 用源音轨 × 0.18（-15dB）作背景——能听到 BGM 但中文人声残留
- **v0.4**：接入 demucs `htdemucs_ft` 模型——真分离 vocals + no_vocals
  - 输入：源视频抽出 44.1kHz stereo wav
  - 命令：`demucs --two-stems vocals -n htdemucs_ft -o <out> <input>`
  - 产物：`stems/vocals.wav` + `stems/accompaniment.wav`
  - 耗时：CPU 上 30s 视频 ≈ 30-60s
- **后处理**：`accompaniment` 再过 `highpass=60, lowpass=8000, acompressor` 压制残留人声

**当前状态**：demucs 通过 `pip install demucs` 装在用户机器；v1.0 发布前会用 PyInstaller 打 standalone binary 内嵌（v0.6 任务）。

### 3.2 ASR：句段细分防"字幕一大段挂屏"

**问题**：Volcano `bigmodel_nostream` 默认返回整 utterance——一句"很长的对白"可能是一个 8-15s 的 segment，字幕烧上去就是"一大段挂在那"。

**方案**：在 ASR 落库前用 `refineUtterances()` 细分：
1. 短句（≤4s 且 ≤20 字）原样保留
2. 长句优先按 `words[]`（词级时间戳）累积，遇 `。！？` 强切；遇 `，；` 且超长再切
3. 没 words 时按字符等比例切（兜底）
4. 切出来太短的（<600ms）合并到前一段

**配置**（`apps/desktop/src/main/stages/asr-cluster-stages.ts:REFINE_CONFIG`）：
```ts
{
  maxDurMs: 4_000,    // 短剧字幕舒适阈值
  maxChars: 20,       // 手机竖屏一行
  minDurMs: 600,      // 避免孤立小词
  hardPunct: /[。！？!?]/,
  softPunct: /[，；、,;:]/,
}
```

### 3.3 视觉辅助分轨：兄弟脸辨识

**问题**：火山 speaker diarization 对兄弟/同年龄段同性别声音容易合并到同一 speaker_id。

**方案**：cluster stage 内对每个 `speakerSegments.length >= 2` 的组调 LLM Vision：
1. 抽出**所有** segments 的代表帧（中点截图，240px JPG，~10KB/张）
2. 多模态 prompt 喂给 MiniMax-M3（走 Anthropic 兼容路径，`image.source.base64`）
3. LLM 返回 `{groups: [{label, frame_indices}]}` JSON
4. 派生 sub-speaker_id（"原 id-0"、"原 id-1"），下游全部按 character_id 走

**踩过的坑**：v1 只采样 4 张代表帧，未采样 segments 兜底归第一组——结果"少数派外貌"拿到的 segments 太少。v2 改为**全部送 LLM**（短剧 < 20 segments，token 成本可控），LLM 必须给每张图打标签。

**Prompt 设计要点**：
- 优先级：发色 → 发型 → 服装 → 面部特征（短剧场景发色最稳定）
- 倾向"同一人"避免假阳性（同一人不同角度/表情会有差异）
- 强制覆盖率：`frame_indices 列出的所有数字必须覆盖全部 N 张，一张不漏`
- 启发式兜底：万一 LLM 漏掉某 frame，按"邻近原则"归到最近被归类 frame 的组

### 3.4 声纹克隆：短样本的循环复制

**问题**：MiniMax Voice Clone API 硬性要求样本 **≥ 10 秒**（错误码 2037 `voice duration too short`）。短剧配角对白短促，5 个角色里经常 3 个不到 10s。

**方案演进**：
- **v1**（错）：样本不足时门槛降到 4s——实测被服务端拒收，所有短样本角色全回退系统音色
- **v2**（错）：补静音 padding 到 10.5s——MiniMax 学到"50% 时间不说话"特征，克隆音色发闷
- **v3**（正确）：**循环复制本角色样本**，每次重复中间夹 100ms 静音作自然停顿

**ffmpeg filter graph 实现**：
```
[0:a]atrim=...[s0]; [0:a]atrim=...[s1];           # 该角色每个 segment 单独裁
[s0][s1]concat=n=2[base];                          # 拼成"基础样本"
[base]asplit=4[b0][b1][b2][b3];                    # 复制 4 份引用
anullsrc=...:d=0.1[gap0]; ... [gap2];              # 3 个短静音
[b0][gap0][b1][gap1][b2][gap2][b3]concat=n=7[outa] # 交替拼接
```

**重复次数计算**：
```
repeats = max(2, ceil((targetMs - baseMs) / (baseMs + gapMs)) + 1)
finalMs = baseMs + (baseMs + gapMs) × (repeats - 1)
```

**铁律**：**绝对不掺别的角色声音进样本**。FIX D2 之前的 bug 是按"该 character 时间区间"裁连续段，里面混了其他角色的对白；现在按 character_id filter 后单独裁每个 segment 再 concat，干净。

### 3.5 emotion 链路：从识别到合成

**Volcano → MiniMax 字段不兼容**：
- Volcano 给：`happy / sad / angry / neutral / surprise / fear / disgust`
- MiniMax 要：`happy / sad / angry / fearful / disgusted / surprised / neutral`

**踩过的坑**：传 `surprise` 给 MiniMax → 错误码 2013 `invalid params: voice_setting emotion` → **整个 TTS 请求失败**（不是 silently ignored）→ 那一句 segment 没声音。

**修复**：
1. `EMOTION_MAP` 表（`packages/provider-MiniMax/src/tts.ts`）：surprise→surprised, fear→fearful, disgust→disgusted；未识别值不传 emotion 字段
2. TTS 调用层兜底：HTTP 200 + body 2013 + msg 包含 "emotion" → 去掉 emotion 字段重试一次（情绪丢但有声音）

**情绪饱满度调优表**（`apps/desktop/src/main/stages/tts-stage.ts:EMOTION_TUNING`）：

| emotion | intensity | speed | vol | pitch (半音) |
|---------|-----------|-------|-----|-----------|
| angry | 1.4 | 1.03 | 1.10 | +1 |
| happy | 1.3 | 1.03 | 1.05 | +1 |
| sad | 1.3 | 0.95 | 0.90 | −1 |
| surprised | 1.4 | 1.05 | 1.05 | +1 |
| fearful | 1.3 | 1.03 | 0.95 | 0 |
| disgusted | 1.3 | 0.98 | 1.00 | 0 |
| neutral | 1.0 | 1.0 | 1.0 | 0 |

**设计要点**：
- intensity 用 MiniMax `emotion_intensity` 参数（[0.5, 2.0]，配合 emotion 才生效）
- speed ±5% 内（人耳不易察觉）、pitch ±1 半音（不变声）—— 这是"够饱满但听不出 AI 痕迹"的甜区
- **不在文本里加语气词**——曾经让 LLM 翻译时主动加 "Hey/Oh/Aduh"，结果撑大 TTS 时长导致 align 反复拉伸失真。ROLLBACK 后改为只调音学参数

### 3.6 时长对齐：5 级级联 + 重译压缩循环

**问题**：印尼语/西语翻译完字符数普遍是中文的 1.5-1.8 倍，TTS 时长溢出 segment 槽位 → 后续 segment 字幕错位、TTS 音频重叠。

**align stage 策略**：
```
Stage 1  fit           偏差 ≤ 100ms     直接放
Stage 2  speed         小偏差            TTS 重合成调 speed（v1.0 跳过，重合成贵）
Stage 3  sola          0.7 ≤ ratio ≤ 1.3 Rubberband 弹性变速（不变音高）
Stage 4  gap-borrow    长出来一点        借用相邻 segment 间隙
Stage 5  video-slow    长出来更多        视频局部慢放 ±5% 容纳
Stage 6  overflow      实在救不回        标红等人工
```

**重译压缩循环**（v0.4 加）：
- planner 前先做 2 轮"压缩重译"：找出 ratio > 1.3 的 segment → LLM 重写更短版（target_chars = 当前 × origDur/ttsDur × 0.85）→ 重新 TTS
- 大幅减少进入 SOLA 的 segment 数（拉伸越多越失真）

**SOLA 范围**（`packages/align-engine/src/types.ts:DEFAULT_ALIGN_CONFIG`）：
```ts
solaRange: [0.7, 1.3]     // Rubberband 在此范围内几乎听不出
speedRange: [0.85, 1.15]  // TTS 重合成 speed 调节范围（v1.0 未启用）
videoSlowMaxRatio: 0.05   // D2 决策：±5% 视频局部慢放
```

### 3.7 系统音色回退：character-index 轮转

**问题**：克隆失败时回退系统音色，最早是固定取 `SYSTEM_VOICES_MALE[0]`——5 个男角色全用同一个音色，听感无法区分。

**方案**：按 gender 分组后给每个 character 一个"组内序号"，模 6（音色池大小）取不同 voice_id：

```ts
// 6 个男系统音色，6 个女系统音色（MiniMax 文档精选跨语种泛化好的）
SYSTEM_VOICES_MALE = ['male-qn-jingying', 'male-qn-qingse', 'male-qn-badao',
                      'presenter_male', 'audiobook_male_1', 'audiobook_male_2']
// 按 speakerId 字典序排序保证稳定（重跑 modulo 顺序一致）
// 同 gender 第 N 个 character → SYSTEM_VOICES_*[N % 6]
```

### 3.8 mix-render：filter graph 防卡死

**踩过的坑**：早期 `apad` 不带 `whole_dur` + `amix duration=longest` → 死循环，ffmpeg 永远不退出，文件无限增长但 moov 不写。

**修复**：
```
[1:a]adelay=startMs|startMs,apad=whole_dur=${wholeDurMs}ms[a0]
                              ^^^^^^^^^^^^^^^^^^^^^^^ 关键
```

**Watchdog**：60s 无 ffmpeg 进度 → `AbortSignal.any()` 强制 kill，避免用户死等。

**amix normalize=0**：关掉默认归一化，否则 12 路 TTS 进来后每路音量被压成 1/14 完全听不见。手动控制 bg=0.7、TTS=1.0、silence=0。

### 3.9 工作台：让流水线可视

**痛点**：之前调情绪/音色全靠"听感"+ 我在 DB 里 sqlite3 查——效率极低且不可持续。

**Workstation 三段式**：
- **上区**：character 网格（头像/姓名/性别/克隆状态/segment 数/总时长）
- **中区**：segment 表（缩略图占位/角色/emotion/原文→译文/时长比对，点击展开）
- **下区**：选中 segment 详情（缩略图大图 + 3 路音频对比 + 可编辑表单 + 重合成按钮）

**关键 IPC**：
- `segment:assets` — 返回单 segment 的所有资产路径 + TTS snapshot
- `segment:resynth` — 单 segment 重合成（保存 override + 调 TTS + 不重 mix-render）
- `system:read-file-as-data-url` — renderer 安全读本地音频/图片转 base64

**DB 持久化** (migration 0002)：
- `tts_*` 7 字段记录"上次合成用了什么参数"
- `user_*` 4 字段记录"导演手动 override"，TTS stage 优先读 override

---

## 4. 经验值与调参手册

### 4.1 demucs 模型选择

| 模型 | 速度 | 精度 | 适用 |
|------|------|------|------|
| `htdemucs` (默认) | 1× | 标准 | 快速预览 |
| `htdemucs_ft` (推荐) | 4× | 高 | 译制生产 |
| `mdx_extra` | 8× | 极高 | 终极质量（v0.6 选项） |

### 4.2 MiniMax API 关键约束

- **Voice Clone**：样本 ≥ 10s（硬性，2037）；≤ 20MB；mp3/wav/m4a
- **TTS emotion**：仅支持白名单 7 值；speech-2.6 以上才生效
- **TTS emotion_intensity**：[0.5, 2.0]，默认 1.0
- **LLM Vision**：Anthropic 兼容 image.source.base64；单请求建议 ≤ 1MB 图片总大小

### 4.3 火山 ASR 调用

```ts
{
  model_name: 'bigmodel',           // 推荐：bigmodel_nostream 准确率最高
  ssd_version: '200',                // 开 speaker_info 必填 200
  enable_itn: true,                  // 数字归一化
  enable_punc: true,                 // 自动标点
  enable_speaker_info: true,         // speaker_id（兄弟脸是它分不开）
  enable_gender_detection: true,     // 给 cluster 投票用
  enable_emotion_detection: true,    // 给 TTS 用
  show_utterances: true,             // 必须 true 才有 word 级时间戳
}
```

### 4.4 MiniMax 价格估算（cents per 1k tokens / chars / s，占位以官方为准）

| 服务 | 单位 | 单价 |
|------|------|------|
| LLM MiniMax-M3 | 1k tokens 输入 | 0.1 |
| LLM MiniMax-M3 | 1k tokens 输出 | 0.3 |
| TTS speech-2.8-hd | 1k chars | 2 |
| TTS speech-2.8-turbo | 1k chars | 1 |
| Voice Clone | 单次 | 0（首次使用 TTS 时计费） |

---

## 5. 已知限制与后续规划

### 5.1 v0.5 已知限制

| 限制 | 影响 | 缓解 |
|------|------|------|
| demucs 需用户预装 | 没装 → demix skip，下游用源音轨兜底，原人声会残留 | v0.6 PyInstaller 打 standalone binary 内嵌 |
| 视觉拆分依赖 LLM Vision | 网络故障 / token 超额时拆分失效 | 失败兜底保持原分组；工作台可手动 fix |
| 短样本克隆质量仍受限 | 即使循环复制，4s 原样本 ×3 不如 30s 真样本 | v0.6 跨集音色资产库：积累多集样本一次性 30s+ 克隆 |
| video-slow 真正生效需 ffmpeg setpts 切片 | 当前 align planner 标了 video-slow 但 mix-render 不真改画面速度 | v0.6 按 segment 切片做 setpts |
| 工作台缩略图懒加载未完善 | 表格里的小缩略图显示占位文字 | v0.5.x 修 |

### 5.2 v0.6 路线

1. **demucs standalone binary** — PyInstaller 打包，体积 +180MB，开箱即用
2. **跨集音色资产库** — 同剧多集复用 voice_id，配角累积样本到 30s+
3. **真 video-slow** — ffmpeg setpts 切片，让 align 的 video-slow 策略生效
4. **更智能的视觉拆分** — InsightFace embedding 聚类作为 LLM Vision 的辅助验证
5. **批量项目** — 一次拖 N 集，模板配置共用，跨集复用音色

### 5.3 v1.0 发布前必做

- [ ] demucs 打包成 standalone binary（macOS + Windows）
- [ ] 工作台缩略图渲染完善（表格内显示真实图，不只是详情区）
- [ ] 错误恢复：网络中断 / token 超额 / 单 stage 崩溃的优雅降级
- [ ] 性能：长视频（> 5min）的 demucs 分片 + 并发 TTS
- [ ] 多语种验证：至少把 40 种语言里 P0 的 10 种各跑一遍冒烟测试

---

## 6. 关键文件索引

### 后端核心

| 文件 | 职责 |
|------|------|
| `apps/desktop/src/main/orchestrator/index.ts` | 装配 14 stage + 调度 |
| `apps/desktop/src/main/stages/demix-stage.ts` | demucs 调用 |
| `apps/desktop/src/main/stages/asr-cluster-stages.ts` | ASR + 句段细分 + cluster + 视觉拆分入口 |
| `apps/desktop/src/main/stages/visual-split.ts` | LLM Vision 拆 speaker |
| `apps/desktop/src/main/stages/voice-clone-stage.ts` | MiniMax 三步走 + 循环复制 |
| `apps/desktop/src/main/stages/translate-stage.ts` | LLM 翻译 + idx 严格映射 |
| `apps/desktop/src/main/stages/tts-stage.ts` | MiniMax TTS + emotion tuning |
| `apps/desktop/src/main/stages/align-stage.ts` | 重译压缩循环 + SOLA |
| `apps/desktop/src/main/stages/ffmpeg-stages.ts` | preprocess + mix-render |
| `apps/desktop/src/main/stages/thumb-extract-stage.ts` | 每 segment 抽帧 |
| `apps/desktop/src/main/stages/subtitle-stage.ts` | ASS/SRT 生成 |
| `packages/provider-MiniMax/src/llm.ts` | LLM 多模态（含 image block） |
| `packages/provider-MiniMax/src/tts.ts` | TTS + emotion mapping |
| `packages/provider-MiniMax/src/clone.ts` | Voice Clone 三步走 |
| `packages/provider-volcengine/src/asr.ts` | 火山 WebSocket ASR |
| `packages/align-engine/src/planner.ts` | 5 级对齐策略 |
| `packages/subtitle/src/ass.ts` | ASS V4+ 渲染 |

### IPC + UI

| 文件 | 职责 |
|------|------|
| `packages/core-types/src/api.ts` | IPC 通道契约（单一来源） |
| `apps/desktop/src/main/ipc/segment.ts` | `segment:assets` + `segment:resynth` |
| `apps/desktop/src/main/ipc/system.ts` | `system:read-file-as-data-url` |
| `apps/desktop/src/main/ipc/pipeline.ts` | `pipeline:start` / `retry-stage` / `reset-all` |
| `apps/desktop/src/renderer/src/components/Workstation.tsx` | 三段式导演工作台 |
| `apps/desktop/src/renderer/src/components/AlignPanel.tsx` | 对齐策略可视化 |
| `apps/desktop/src/renderer/src/pages/Workbench.tsx` | 主页 + 3 tab |

### Schema

| 文件 | 职责 |
|------|------|
| `apps/desktop/src/main/migrations/0001_init.sql` | 初始 schema |
| `apps/desktop/src/main/migrations/0002_segment_assets.sql` | TTS snapshot + user override + thumb 列 |

---

## 7. 修复日志（按时间顺序）

按 FIX 编号串起来，便于回查"为什么这么写"：

```
A   零摩擦桌面集成 — ffmpeg 通过 @ffmpeg-installer + asarUnpack
B   stage 错误暴露 — pipeline.ts 桥接 logger.error + UI 错误 banner
C   mix-render 卡死 — apad 加 whole_dur + 60s watchdog
D1  火山 speaker_id 抓取 — 多位置 fallback（top / additions / words 多数派）
D2  克隆样本污染 — atrim + concat 每角色单独裁，不连续区间裁
E1  BGM 保留 — mix-render 加原音轨作背景压低 -15dB（v0.3 兜底）
E2  ASR 句段细分 — refineUtterances 按标点 + 长度阈值切
E3  翻译 idx 严格 — JSON key 用 idx 真值 + 不再用 [翻译失败] 占位
F   真 demix — demucs htdemucs_ft，全链路改读 vocals.wav / accompaniment.wav
G   accompaniment 二次降噪 — highpass + lowpass + acompressor
H1  TTS 长溢出 — align stage 内重译压缩 2 轮循环
H2  TTS 不足 — SOLA 拉长 TTS 到 origDur 保持唇形对齐
H3  男女搞错 — gender 按 utterance 时长加权投票 + 65% 显著性
I1  emotion mapping — surprise→surprised 等 + 2013 错误兜底
I2  样本不足 — 改回循环复制（FIX L1 之前的中间方案是 padding，已替换）
I3  系统音色轮转 — 6 个池子 modulo character 序号
J1  emotion_intensity — TTS 加 0.5-2.0 强度参数
J2  翻译加语气词 → ROLLBACK — 撑大时长导致失真，回退
J3  按 emotion 调音学参数 — speed/vol/pitch 微调表
K1-6 工作台 — 三段式 UI + 6 个新 IPC + 2 列 DB
L1  克隆循环复制 — 替代静音 padding，避免发闷
M1-3 LLM 多模态 + 视觉拆分 — ChatMessage 加 ContentBlock[]
N1  视觉拆分覆盖率 — 全部 segments 送 LLM，不再 4 张采样
```

---

**文档版本**：v0.5 / 2026-06-08
**主要贡献者**：minimax · Claude Code
