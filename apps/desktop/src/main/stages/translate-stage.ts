import type { Stage, StageRunContext, StageResult, ChatMessage } from '@dramaprime/core-types'
import { asProjectId, asSegmentId } from '@dramaprime/core-types'
import { providers } from '../providers/index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { CharacterRepo } from '../storage/character-repo.js'
import { db } from '../storage/index.js'

/**
 * v0.2.b translate stage：调 MiniMax M3 翻译所有句子。
 *
 * 设计要点（与 PRD §9.4 一致）：
 *   - 按场景批次（每 batch ≤ N 句，避免上下文丢失 + 单次太长）
 *   - prompt 注入：角色信息、字数预算 K 系数（zh→tgt）
 *   - JSON 结构化输出，按 segment id 回填
 *   - 失败时整 batch 重试一次，再失败标 fit_strategy=overflow（不阻塞 pipeline）
 */
export const translateStage: Stage = {
  name: 'translate',
  version: 1,
  inputsFrom: ['asr-diarize', 'cluster'],
  blocking: true,
  retries: 1,
  kind: 'provider',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const segs = SegmentRepo.list(ctx.projectId as any)
    if (segs.length === 0) {
      return {
        kind: 'failed',
        error: {
          code: 'pipeline.upstream-missing',
          message: '没有 segments，translate 无法进行',
          retriable: false,
        },
      }
    }
    const characters = CharacterRepo.list(ctx.projectId as any)
    const charMap = new Map(characters.map((c) => [c.id, c]))
    const targetLang = project.targetLang
    const k = K_TABLE[targetLang] ?? 1.6
    const llm = providers().llm

    // 分批：每批 ≤ 12 句，按原顺序
    const BATCH = 12
    const batches: typeof segs[] = []
    for (let i = 0; i < segs.length; i += BATCH) batches.push(segs.slice(i, i + BATCH))

    let done = 0
    let totalIn = 0
    let totalOut = 0
    let totalCents = 0

    for (let bi = 0; bi < batches.length; bi++) {
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
      const batch = batches[bi]!
      const messages = buildBatchMessages(batch, charMap, targetLang, k)

      ctx.reportProgress(
        Math.round((done / segs.length) * 90),
        `翻译 batch ${bi + 1}/${batches.length}`,
      )

      let batchResult: Record<string, BatchItem>
      try {
        const res = await llm.chat({
          model: 'MiniMax-M3',
          messages,
          maxTokens: 2048,
          temperature: 0.6,
          expectJson: true,
          signal: ctx.signal,
        })
        totalIn += res.usage.promptTokens
        totalOut += res.usage.completionTokens
        totalCents += res.costCents
        batchResult = parseBatchJson(res.text)
      } catch (err) {
        ctx.logger.warn('翻译 batch 失败，跳过（保留 src_text 不写 tgt）', {
          batch: bi,
          err: String((err as any)?.message ?? err),
        })
        // ★ 关键修复：以前用"[翻译失败]"撑满整 batch，导致每个 segment 字幕都是同一行——
        // 现在直接 batchResult = {} 不写 tgt_text，字幕渲染会跳过 tgtText 为空的 segment
        batchResult = {}
      }

      // 回写 SQLite，**严格按 idx 匹配**，缺失就不写
      // 之前 LLM 偶尔返回 "0"/"1"/"2" 而不是 segment.idx 真值（11/12/13），
      // 这里加 idx 范围校验 + 日志告警
      const validIdxSet = new Set(batch.map((s) => String(s.idx)))
      const responseKeys = Object.keys(batchResult)
      const unknownKeys = responseKeys.filter((k) => !validIdxSet.has(k))
      const missingIdxs = batch
        .map((s) => String(s.idx))
        .filter((k) => !(k in batchResult))
      if (unknownKeys.length > 0 || missingIdxs.length > 0) {
        ctx.logger.warn('翻译 batch idx 映射不匹配', {
          batch: bi,
          unknownKeys,
          missingIdxs,
          expectedIdxs: batch.map((s) => s.idx),
        })
      }

      // ★ v0.4.3 防"合并翻译"校验：检测同一 batch 内多个 idx 返回相同 tgt_text
      // 这是 M3 把意思连贯的相邻句子合并到一句长译文的典型症状
      // 用户实际反馈过：3 张连续帧里"印尼语完全不动、只有中文换"
      const dupKeys = findDuplicateTranslations(batchResult)
      if (dupKeys.length > 0) {
        ctx.logger.warn('翻译 batch 检测到重复 tgt（疑似 M3 合并翻译），尝试单句重译', {
          batch: bi,
          duplicateIdxs: dupKeys,
          sample: batchResult[dupKeys[0]!]?.text?.slice(0, 60),
        })
        // 对每个重复的 idx 单独发一次 LLM 调用——单句没有"相邻语境"，M3 不会再合并
        await retranslateIndividually(
          llm,
          batch.filter((s) => dupKeys.includes(String(s.idx))),
          charMap,
          targetLang,
          k,
          batchResult,
          ctx,
        )
      }

      const stmt = db().prepare(
        `UPDATE segments SET tgt_text = ? WHERE id = ?`,
      )
      const tx = db().transaction(() => {
        for (const s of batch) {
          const r = batchResult[String(s.idx)]
          if (r && typeof r.text === 'string' && r.text.trim()) {
            stmt.run(r.text.trim(), s.id)
          }
          // 没匹配上的 segment 留 tgt_text=null；下游 subtitle/tts 会跳过它
        }
      })
      tx()

      done += batch.length
    }

    // 上报成本
    if (totalCents > 0) {
      ctx.reportCost({
        projectId: asProjectId(project.id),
        stage: 'translate',
        provider: 'MiniMax',
        model: 'MiniMax-M3',
        units: totalIn + totalOut,
        unitKind: 'tokens',
        cents: totalCents,
        ts: Date.now(),
      })
    }

    ctx.reportProgress(100, `翻译完成 ${done}/${segs.length}`)
    return {
      kind: 'ok',
      outputs: { translated: String(done) },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── prompt 构造 ──────────────────────────────────────────────────────

interface BatchItem {
  text: string
  est_dur?: number
}

const buildBatchMessages = (
  batch: Array<{
    id: string
    idx: number
    startMs: number
    endMs: number
    characterId: string | null
    srcText: string | null
    emotion: string | null
  }>,
  charMap: Map<string, { id: string; name: string | null; gender: string | null; ageBand: string | null }>,
  targetLang: string,
  k: number,
): ChatMessage[] => {
  const langLabel = LANG_LABEL[targetLang] ?? targetLang
  const regionRule = REGION_NEUTRAL[targetLang] ?? ''

  const systemPrompt = `你是专业的短剧译制译者，将中文台词翻译为${langLabel}。

# 核心要求（违反任何一条都会导致字幕错位 / 配音不同步）

## A. 严格 1:1 翻译（最重要！）
- 输入 N 个 idx，输出**必须 N 个**键值对，**每个 idx 对应独立译文**
- ❌ **绝对禁止把相邻 idx 的意思合并到一句长译文里**——即使两句意思连贯也要分开
- ❌ **绝对禁止两个 idx 的 text 字段返回相同字符串**
- ✅ 每个 idx 的译文**只翻译该 idx 的 orig 字段内容**，不要看相邻 idx 的内容

【反例，禁止】（输入 3 句 → 输出合并成 1 长句重复 3 次）：
输入：
[{"idx":5,"orig":"你弟弟现在结婚急用钱"},{"idx":6,"orig":"你还一直算旧账"},{"idx":7,"orig":"娇娇看中的房子"}]
错误输出：
{"5":{"text":"Adik mau nikah butuh uang, kamu masih hitung soal rumah Jiaojiao."},"6":{"text":"Adik mau nikah butuh uang, kamu masih hitung soal rumah Jiaojiao."},"7":{"text":"Adik mau nikah butuh uang, kamu masih hitung soal rumah Jiaojiao."}}

【正例】（每句独立翻译）：
{"5":{"text":"Adikmu mau nikah, butuh uang"},"6":{"text":"Kamu masih ungkit-ungkit utang lama"},"7":{"text":"Rumah yang Jiaojiao incar"}}

## B. 翻译质量
1. **忠实翻译该 idx 自己的 orig**——不要省略、也不要添加原句没有的字（包括感叹词 / 语气词 / "Hey/Oh/Wah" 之类）
2. **口语化**、符合${langLabel}配音节奏——不要书面化、不要文学化
3. **保留情绪强度**——感叹号 ！ 在译文中保留（TTS 会读出重音）
4. 符合角色性别 / 年龄称谓
5. **每句长度 ≤ char_budget 字符**

## C. 输出格式
- JSON 的 key 必须用输入提供的 idx（数字字符串），不要用 0/1/2 顺序号
- 仅输出 JSON 对象，不要 markdown fence、不要任何解释文字${regionRule}

输出格式：
{
  "<idx>": {"text": "<该 idx 的独立译文>", "est_dur": <估算时长ms>},
  ...
}`

  const items = batch.map((s) => {
    const char = s.characterId ? charMap.get(s.characterId) : null
    const durMs = s.endMs - s.startMs
    const origChars = (s.srcText ?? '').length
    const charBudget = Math.max(8, Math.round(origChars * k))
    return {
      idx: s.idx,
      orig: s.srcText ?? '',
      char_budget: charBudget,
      dur_ms: durMs,
      character: char?.name ?? null,
      gender: char?.gender ?? null,
      age: char?.ageBand ?? null,
      emotion: s.emotion ?? 'neutral', // 仅作为元数据传给下游 TTS，**不要**让 LLM 据此改写文本
    }
  })

  const userPrompt = `请翻译以下 ${batch.length} 句台词到${langLabel}：

${JSON.stringify(items, null, 2)}

直接返回 JSON 对象，键为 segment idx 字符串。`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

/**
 * 容错解析：M3 有时返回 ```json ...```、有时多了前后解释文字。
 * 这里抓第一个 { 到最后一个 } 之间的内容做 JSON.parse。
 */
const parseBatchJson = (text: string): Record<string, BatchItem> => {
  const cleaned = text.trim()
  let jsonStr = cleaned
  // 去除 ```json ... ``` 包裹
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) jsonStr = fence[1].trim()
  // 再次兜底：抓首个 { 到末尾 }
  const start = jsonStr.indexOf('{')
  const end = jsonStr.lastIndexOf('}')
  if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1)
  try {
    const data = JSON.parse(jsonStr) as Record<string, unknown>
    const out: Record<string, BatchItem> = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') {
        out[k] = { text: v }
      } else if (v && typeof v === 'object') {
        const obj = v as any
        if (typeof obj.text === 'string') {
          out[k] = { text: obj.text, est_dur: Number(obj.est_dur) || undefined }
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

// ─── 防"合并翻译"工具 ────────────────────────────────────────────────

/**
 * 检测同一 batch 内有哪些 idx 共享了相同的 tgt_text。
 *
 * 触发场景：M3 看到 3 个意思连贯的中文 segment 时，会偷懒返回：
 *   {"5": "long sentence covering 5+6+7", "6": "long sentence covering 5+6+7", ...}
 * 视觉症状：连续帧字幕中文换、译文不动。
 *
 * 判定：忽略大小写 + 去首尾空格后字符串相等。
 * 返回所有"参与了重复"的 idx 列表（不含独占组）。
 */
const findDuplicateTranslations = (batchResult: Record<string, BatchItem>): string[] => {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
  const groups = new Map<string, string[]>()
  for (const [idx, item] of Object.entries(batchResult)) {
    if (!item?.text) continue
    const key = norm(item.text)
    // 太短不算（"yes"/"no" 这种重复属正常）；> 8 字符的相同才算可疑
    if (key.length < 8) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(idx)
  }
  const dup: string[] = []
  for (const ids of groups.values()) {
    if (ids.length >= 2) dup.push(...ids)
  }
  return dup
}

/**
 * 对疑似被合并翻译的 idx 单独发起 LLM 调用——单独发送时没有"相邻语境"，
 * M3 不会再把这一句和别的句子合并。
 *
 * 替换 batchResult 里这些 idx 的 text 字段（原地修改）；调用失败保留原值。
 *
 * 为啥不批量重试？批量重试很可能再次合并；单句独立调用最能避免"合并偏好"。
 * 代价是 N 次 LLM 调用，但只在 batch 出错时触发，不是常态。
 */
const retranslateIndividually = async (
  llm: ReturnType<typeof providers>['llm'],
  badSegs: Array<{
    id: string
    idx: number
    startMs: number
    endMs: number
    characterId: string | null
    srcText: string | null
    emotion: string | null
  }>,
  charMap: Map<string, { id: string; name: string | null; gender: string | null; ageBand: string | null }>,
  targetLang: string,
  k: number,
  batchResult: Record<string, BatchItem>,
  ctx: StageRunContext,
): Promise<void> => {
  const langLabel = LANG_LABEL[targetLang] ?? targetLang

  for (const s of badSegs) {
    if (ctx.signal.aborted) return
    const char = s.characterId ? charMap.get(s.characterId) : null
    const origChars = (s.srcText ?? '').length
    const charBudget = Math.max(8, Math.round(origChars * k))
    // 极简 prompt——只翻一句、没有上下文、不可能合并
    const sysPrompt = `你是专业的短剧译制译者。只翻译给定的**一句**中文台词到${langLabel}。
要求：口语化、忠实、不省略、不添加、≤ ${charBudget} 字符。
直接返回 JSON：{"text": "<译文>"}`
    const userPrompt = JSON.stringify({
      orig: s.srcText ?? '',
      character: char?.name ?? null,
      gender: char?.gender ?? null,
      emotion: s.emotion ?? 'neutral',
    })
    try {
      const res = await llm.chat({
        model: 'MiniMax-M3',
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 512,
        temperature: 0.5,
        expectJson: true,
        signal: ctx.signal,
      })
      const cleaned = res.text.trim()
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as { text?: unknown }
      if (typeof obj.text === 'string' && obj.text.trim()) {
        batchResult[String(s.idx)] = { text: obj.text.trim() }
        ctx.logger.info('单句重译成功', { idx: s.idx, len: obj.text.length })
      }
    } catch (err) {
      ctx.logger.warn('单句重译失败，保留原合并译文', {
        idx: s.idx,
        err: String((err as any)?.message ?? err),
      })
    }
  }
}

// ─── 配置表（精简版，全语种见附录 A.2） ──────────────────────────────

const K_TABLE: Record<string, number> = {
  en: 1.6,
  es: 1.8,
  pt: 1.7,
  ja: 1.3,
  id: 1.5,
  ko: 1.2,
  vi: 1.6,
  th: 1.4,
  ar: 1.5,
  fr: 1.7,
  de: 1.6,
  ru: 1.5,
  it: 1.7,
  tr: 1.5,
  fil: 1.6,
  ms: 1.5,
  hi: 1.5,
  pl: 1.6,
  nl: 1.7,
  yue: 1.0,
}

const LANG_LABEL: Record<string, string> = {
  en: '英语',
  es: '西班牙语',
  pt: '葡萄牙语',
  ja: '日语',
  id: '印尼语',
  ko: '韩语',
  vi: '越南语',
  th: '泰语',
  ar: '阿拉伯语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
  it: '意大利语',
  tr: '土耳其语',
  fil: '菲律宾语',
  ms: '马来语',
  hi: '印地语',
  pl: '波兰语',
  nl: '荷兰语',
  yue: '粤语',
}

const REGION_NEUTRAL: Record<string, string> = {
  en: '\n6. 使用中性 General American 拼写，避免英式 colour/centre。',
  es: '\n6. 默认 LATAM 中性西语：**禁用 vosotros 变位**；慎用 coger（拉美俚语含义）。',
  pt: '\n6. 默认 pt-BR：你→você，避免欧葡 tu 变位。',
  ar: '\n6. 走 MSA（现代标准阿拉伯语），避免埃及/海湾方言。',
  fr: '\n6. 默认欧法，避免 char→tank 等加拿大特有口语。',
  de: '\n6. 标准德语，避免奥地利/瑞士专属词。',
  nl: '\n6. 标准荷语，避免比利时弗拉芒专属词。',
  id: '\n6. 中性印尼语，避免 Bahasa Melayu 专属词。',
  ms: '\n6. 默认马来西亚标准，避免印尼语借词混用。',
  fil: '\n6. 中性 Tagalog，慎用宿务语借词。',
  vi: '\n6. 中性北越为主，避免南越方言。',
}

/**
 * 各目标语种的常见口语语气词 / 感叹词——给 LLM 看，让译文更自然更有"喘息感"。
 * 短剧 dubbing 关键：加了这些之后听起来才像"真人在说话"而不是"在念稿"。
 */
const INTERJECTION_HINT: Record<string, string> = {
  en: '"oh"/"uh"/"hey"/"ah"/"wow"/"hmm"/"yeah"/"well"',
  es: '"ay"/"oye"/"bueno"/"vaya"/"eh"/"pues"/"vale"',
  pt: '"ah"/"oh"/"ué"/"né"/"nossa"/"tá"/"hein"',
  ja: '"あの"/"ええと"/"うん"/"へえ"/"ね"/"よ"/"ああ"',
  id: '"eh"/"loh"/"kan"/"sih"/"deh"/"dong"/"wah"/"aduh"',
  ko: '"어"/"음"/"아"/"야"/"네"/"뭐"/"오"',
  vi: '"ờ"/"à"/"ơi"/"đấy"/"thôi"/"này"/"thì"',
  th: '"เออ"/"นะ"/"จัง"/"แหละ"/"โอ้"/"อ้าว"/"เอ้"',
  ar: '"يا"/"ها"/"آه"/"يااه"/"ولله"/"طب"',
  fr: '"euh"/"ben"/"bah"/"oh"/"ah"/"eh"/"hein"',
  de: '"ach"/"naja"/"hm"/"tja"/"echt"/"oh"',
  ru: '"ну"/"ой"/"ах"/"эй"/"же"/"ведь"',
  it: '"eh"/"beh"/"oh"/"ah"/"mah"/"dai"',
  tr: '"ay"/"ya"/"hadi"/"vay"/"yahu"/"abi"',
  fil: '"oo"/"naku"/"grabe"/"ay"/"diba"/"naman"',
  ms: '"eh"/"alamak"/"lah"/"kan"/"weh"',
  hi: '"arre"/"oye"/"haan"/"yaar"/"oho"',
  pl: '"no"/"oj"/"ach"/"ehh"',
  nl: '"hè"/"oh"/"nou"/"goh"',
  yue: '"哎"/"咧"/"啦"/"喎"/"嘛"/"嗰"',
}
