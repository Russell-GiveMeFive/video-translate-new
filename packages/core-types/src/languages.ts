/**
 * 全 40 语种主数据表 —— 来源：PRD 附录 A.2 + MiniMax Speech-2.8 支持范围。
 *
 * 设计原则：
 *   - 单一来源（Single Source of Truth）：UI 下拉、翻译 prompt、字幕渲染、
 *     QA 校准都从这张表读
 *   - tier 决定校准强度（P0 = 人工盲测 30 集；P1 = 主观盲测；P2 = 仅冒烟）
 *   - kFactor = zh→X 字符数膨胀系数（控长翻译 prompt 用）
 *   - rhythmFactor = 相对中文的语音时长系数（align engine 提示）
 *   - rtl = 从右到左书写
 *   - needsFont = 是否需要打包专用字体族
 */

export type LangTier = 'P0' | 'P1' | 'P2'

export interface LanguageEntry {
  /** ISO 639-1 code（如 en、es、ja）；少数用 ISO 639-3（fil、yue） */
  code: string
  /** 中文显示名 */
  zhName: string
  /** 英文显示名 */
  enName: string
  /** 校准等级：P0 主力 / P1 重点 / P2 覆盖 */
  tier: LangTier
  /** zh → X 字符膨胀系数 */
  kFactor: number
  /** 相对中文的语音节奏系数 */
  rhythmFactor: number
  /** RTL：从右到左 */
  rtl?: boolean
  /** 需要专用字体族（Noto Sans X 等） */
  needsFont?: string
  /** 内部 prompt 地区中性化要点（用于翻译 stage 注入） */
  regionNeutralRule?: string
}

export const LANGUAGES: readonly LanguageEntry[] = [
  // ── P0 主力（5）───────────────────────────────────────────────────
  { code: 'en', zhName: '英语', enName: 'English', tier: 'P0', kFactor: 1.6, rhythmFactor: 1.15,
    regionNeutralRule: '使用中性 General American 拼写，避免英式 colour/centre。' },
  { code: 'es', zhName: '西班牙语', enName: 'Spanish', tier: 'P0', kFactor: 1.8, rhythmFactor: 1.20,
    regionNeutralRule: '默认 LATAM 中性西语：禁用 vosotros 变位；慎用 coger（拉美俚语含义）。' },
  { code: 'pt', zhName: '葡萄牙语', enName: 'Portuguese', tier: 'P0', kFactor: 1.7, rhythmFactor: 1.15,
    regionNeutralRule: '默认 pt-BR：你→você，避免欧葡 tu 变位。' },
  { code: 'ja', zhName: '日语', enName: 'Japanese', tier: 'P0', kFactor: 1.3, rhythmFactor: 1.05,
    needsFont: 'Noto Sans JP' },
  { code: 'id', zhName: '印尼语', enName: 'Indonesian', tier: 'P0', kFactor: 1.5, rhythmFactor: 1.10,
    regionNeutralRule: '中性印尼语，避免 Bahasa Melayu 专属词。' },

  // ── P1 重点（15）──────────────────────────────────────────────────
  { code: 'ko', zhName: '韩语', enName: 'Korean', tier: 'P1', kFactor: 1.2, rhythmFactor: 1.00,
    needsFont: 'Noto Sans KR' },
  { code: 'vi', zhName: '越南语', enName: 'Vietnamese', tier: 'P1', kFactor: 1.6, rhythmFactor: 1.10,
    regionNeutralRule: '中性北越为主，避免南越方言。' },
  { code: 'th', zhName: '泰语', enName: 'Thai', tier: 'P1', kFactor: 1.4, rhythmFactor: 1.05,
    needsFont: 'Noto Sans Thai' },
  { code: 'ar', zhName: '阿拉伯语', enName: 'Arabic', tier: 'P1', kFactor: 1.5, rhythmFactor: 1.10,
    rtl: true, needsFont: 'Noto Sans Arabic',
    regionNeutralRule: '走 MSA（现代标准阿拉伯语），避免埃及/海湾方言。' },
  { code: 'fr', zhName: '法语', enName: 'French', tier: 'P1', kFactor: 1.7, rhythmFactor: 1.15,
    regionNeutralRule: '默认欧法，避免 char→tank 等加拿大特有口语。' },
  { code: 'de', zhName: '德语', enName: 'German', tier: 'P1', kFactor: 1.6, rhythmFactor: 1.15,
    regionNeutralRule: '标准德语，避免奥地利/瑞士专属词。' },
  { code: 'ru', zhName: '俄语', enName: 'Russian', tier: 'P1', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'it', zhName: '意大利语', enName: 'Italian', tier: 'P1', kFactor: 1.7, rhythmFactor: 1.15 },
  { code: 'tr', zhName: '土耳其语', enName: 'Turkish', tier: 'P1', kFactor: 1.5, rhythmFactor: 1.10 },
  { code: 'pl', zhName: '波兰语', enName: 'Polish', tier: 'P1', kFactor: 1.6, rhythmFactor: 1.15 },
  { code: 'nl', zhName: '荷兰语', enName: 'Dutch', tier: 'P1', kFactor: 1.7, rhythmFactor: 1.15,
    regionNeutralRule: '标准荷语，避免比利时弗拉芒专属词。' },
  { code: 'hi', zhName: '印地语', enName: 'Hindi', tier: 'P1', kFactor: 1.5, rhythmFactor: 1.10,
    needsFont: 'Noto Sans Devanagari' },
  { code: 'ms', zhName: '马来语', enName: 'Malay', tier: 'P1', kFactor: 1.5, rhythmFactor: 1.10,
    regionNeutralRule: '默认马来西亚标准，避免印尼语借词混用。' },
  { code: 'yue', zhName: '粤语', enName: 'Cantonese', tier: 'P1', kFactor: 1.0, rhythmFactor: 1.00 },
  { code: 'fil', zhName: '菲律宾语', enName: 'Filipino', tier: 'P1', kFactor: 1.6, rhythmFactor: 1.10,
    regionNeutralRule: '中性 Tagalog，慎用宿务语借词。' },

  // ── P2 覆盖（20）──────────────────────────────────────────────────
  { code: 'uk', zhName: '乌克兰语', enName: 'Ukrainian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'ro', zhName: '罗马尼亚语', enName: 'Romanian', tier: 'P2', kFactor: 1.7, rhythmFactor: 1.15 },
  { code: 'el', zhName: '希腊语', enName: 'Greek', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15,
    needsFont: 'Noto Sans Greek' },
  { code: 'cs', zhName: '捷克语', enName: 'Czech', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'fi', zhName: '芬兰语', enName: 'Finnish', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10 },
  { code: 'bg', zhName: '保加利亚语', enName: 'Bulgarian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15,
    needsFont: 'Noto Sans Cyrillic' },
  { code: 'da', zhName: '丹麦语', enName: 'Danish', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10 },
  { code: 'he', zhName: '希伯来语', enName: 'Hebrew', tier: 'P2', kFactor: 1.4, rhythmFactor: 1.05,
    rtl: true, needsFont: 'Noto Sans Hebrew' },
  { code: 'fa', zhName: '波斯语', enName: 'Persian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10,
    rtl: true, needsFont: 'Noto Sans Arabic' },
  { code: 'sk', zhName: '斯洛伐克语', enName: 'Slovak', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'sv', zhName: '瑞典语', enName: 'Swedish', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10 },
  { code: 'hr', zhName: '克罗地亚语', enName: 'Croatian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'hu', zhName: '匈牙利语', enName: 'Hungarian', tier: 'P2', kFactor: 1.6, rhythmFactor: 1.15 },
  { code: 'no', zhName: '挪威语', enName: 'Norwegian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10,
    regionNeutralRule: 'Bokmål 优先。' },
  { code: 'sl', zhName: '斯洛文尼亚语', enName: 'Slovenian', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.15 },
  { code: 'ca', zhName: '加泰罗尼亚语', enName: 'Catalan', tier: 'P2', kFactor: 1.7, rhythmFactor: 1.15 },
  { code: 'nn', zhName: '尼诺斯克语', enName: 'Nynorsk', tier: 'P2', kFactor: 1.5, rhythmFactor: 1.10 },
  { code: 'ta', zhName: '泰米尔语', enName: 'Tamil', tier: 'P2', kFactor: 1.4, rhythmFactor: 1.10,
    needsFont: 'Noto Sans Tamil' },
  { code: 'af', zhName: '阿非利卡语', enName: 'Afrikaans', tier: 'P2', kFactor: 1.6, rhythmFactor: 1.10 },
  { code: 'km', zhName: '高棉语', enName: 'Khmer', tier: 'P2', kFactor: 1.4, rhythmFactor: 1.10,
    needsFont: 'Noto Sans Khmer' },
] as const

/** ISO code → entry，快速查找 */
export const LANG_MAP: Record<string, LanguageEntry> = Object.fromEntries(
  LANGUAGES.map((l) => [l.code, l]),
)

/** 按 code 返回中文名（找不到就返回 code） */
export const getLangZhName = (code: string): string => LANG_MAP[code]?.zhName ?? code

/** P0/P1/P2 按等级分组（用于 UI 下拉分段显示） */
export const LANGUAGES_BY_TIER: Record<LangTier, readonly LanguageEntry[]> = {
  P0: LANGUAGES.filter((l) => l.tier === 'P0'),
  P1: LANGUAGES.filter((l) => l.tier === 'P1'),
  P2: LANGUAGES.filter((l) => l.tier === 'P2'),
}
