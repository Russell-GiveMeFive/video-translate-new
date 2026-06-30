/**
 * 字幕单句自动折行——把超长译文按字符上限拆成多行，插入 \N。
 *
 * 为什么 libass 自带的换行不够用？
 *   - libass WrapStyle: 0 / 2 都按"画面宽度"算：超出才换行
 *   - 但 48pt 字号下，1080px 宽 ≈ 22-24 个中文字才撑满
 *   - 短剧译文常 30+ 字，肉眼"一坨"但 libass 觉得"还没满"，不换
 *   - 我们要的是**按字符数主动换行**，让单行始终保持舒服密度
 *
 * 设计原则：
 *   - 优先在"标点后"换行（句末 / 句中标点都行）——读起来不撕裂语义
 *   - 其次在"空格后"换行——英文场景必要
 *   - 都没有再走硬切（中文长串无标点的极端情况）
 *   - 最多换 2 行：3 行+ 时宁可让最后一行长一点也不再拆
 *     （理由：短剧字幕停留时间短，3 行扫不完反而更糟）
 *   - **不在 \N 前后留多余空格**——ASS 渲染时会变成可见空格
 */

/**
 * 智能折行：把一行长文本按软上限拆成 1-2 行，用 \N 连接。
 *
 * @param text 原文（可能含中英标点）
 * @param maxChars 单行字符数软上限（不传时直接返回 text，不折行）
 * @returns 已折行的字符串（行间用 "\N" 分隔，ASS 直接吃）
 *
 * 行为：
 *   - 长度 ≤ maxChars：原样返回
 *   - 长度 ≤ maxChars × 2：切成 2 行
 *   - 长度  > maxChars × 2：仍然切成 2 行（第 2 行可能超长，等 libass 兜底）
 *
 * 切点选择策略（按优先级）：
 *   1. 在 [maxChars × 0.6, maxChars × 1.2] 范围内找"标点后"位置
 *      标点定义：。！？，、；：!?,;: —— 空格也算"软标点"
 *   2. 找不到标点 → 在 [maxChars × 0.7, maxChars × 1.3] 找空格
 *   3. 还找不到 → 硬切在 maxChars 位置
 *
 * TODO（user implementation）：实现这个函数。这是字幕观感的核心——
 * 切得不好会出现"逗号孤立在第 2 行行首"或"英文 word 被劈两半"等观感问题。
 *
 * 参考实现骨架（5-10 行）：
 *   if (!maxChars || text.length <= maxChars) return text
 *   const splitAt = findBestSplit(text, maxChars)  // 找最佳切点
 *   const head = text.slice(0, splitAt).trimEnd()
 *   const tail = text.slice(splitAt).trimStart()
 *   if (!tail) return head
 *   return `${head}\\N${tail}`
 *
 * 其中 findBestSplit 是关键决策——见上文 3 级优先级。
 * 你可以选择更激进（标点窗口给更宽）或更保守（只在硬上限切）。
 */
export function wrapCueText(text: string, maxChars: number | undefined): string {
  // TODO: 实现按 maxChars 软上限的智能折行
  // 当前是 placeholder：直接返回原文（保持现状不折行）
  if (!maxChars || text.length <= maxChars) return text
  return text
}

/**
 * 标点字符集合（用于 findBestSplit 的优先级 1）。
 * 包含中英文常见标点；空格作为"软标点"由 findBestSplit 单独处理。
 */
export const PUNCTUATION = new Set<string>([
  '。', '！', '？', '，', '、', '；', '：',
  '!', '?', ',', ';', ':', '.',
  '—', '…',
])
