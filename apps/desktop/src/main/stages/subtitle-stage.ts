import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult } from '@dramaprime/core-types'
import { renderAss, renderSrt, type SubtitleCue } from '@dramaprime/subtitle'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'

/**
 * v0.4 真实 subtitle-burn stage：
 *   1. 从 SQLite 读 segments，构造 SubtitleCue 数组
 *   2. 生成 ASS（含中英双语布局 + 样式）→ subs/out.ass
 *   3. 生成 SRT（双语 / 单语，软字幕用）→ subs/out.srt
 *   4. 把产物路径写到 outputs，供 mix-render 烧入画面
 *
 * 注意：该 stage **不**实际烧到视频上——烧入由 mix-render 在 ffmpeg
 * filter_complex 里加 subtitles= 完成。这样设计的好处：
 *   - 字幕生成与烧录解耦，未来用户只想要 .srt 不想烧画面也支持
 *   - 用户可以编辑 .ass 后重跑 mix-render，不用重生成字幕
 */
export const subtitleBurnStage: Stage = {
  name: 'subtitle-burn',
  version: 1,
  inputsFrom: ['align'],
  blocking: false, // 失败不阻塞 mix-render，只是没字幕而已
  retries: 1,
  kind: 'main',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    const segs = SegmentRepo.list(ctx.projectId as any).filter(
      (s) => (s.tgtTextEdited ?? s.tgtText)?.trim(),
    )
    if (segs.length === 0) {
      return { kind: 'skipped', reason: '没有可用译文，跳过字幕生成' }
    }

    // ★ v0.4.4 自检：检测"多 segment 共享相同 tgtText"——字幕重合 bug 的铁证
    // 之前要求用户跑 SQL 太麻烦，直接进 logger 让用户在 main 终端看到
    const tgtTextGroups = new Map<string, number[]>()
    for (const s of segs) {
      const tgt = (s.tgtTextEdited ?? s.tgtText ?? '').trim()
      if (tgt.length < 8) continue // 短译文重复正常（"好"/"OK"）
      const norm = tgt.toLowerCase().replace(/\s+/g, ' ')
      if (!tgtTextGroups.has(norm)) tgtTextGroups.set(norm, [])
      tgtTextGroups.get(norm)!.push(s.idx)
    }
    const duplicateGroups = Array.from(tgtTextGroups.entries()).filter(
      ([, idxs]) => idxs.length >= 2,
    )
    if (duplicateGroups.length > 0) {
      ctx.logger.error('⚠️ 字幕重合 bug 复现：多个 segment 拿到相同 tgt_text', {
        duplicateGroupCount: duplicateGroups.length,
        samples: duplicateGroups.slice(0, 5).map(([text, idxs]) => ({
          idxs,
          text: text.slice(0, 60),
        })),
      })
      ctx.logger.error('→ 这说明 translate-stage 的 retranslateIndividually 没救回来，或者根本没触发。请把上面 samples 发给开发者。')
    } else {
      ctx.logger.info('字幕 1:1 校验通过', { segCount: segs.length })
    }

    // 视频分辨率：从 metadata.json 读（preprocess 阶段已写）；缺时用 1080p 兜底
    const metrics = await readVideoMetrics(ctx.projectDir, project.config.renderPreset)

    ctx.reportProgress(20, '构造字幕 cue')
    const cues: SubtitleCue[] = segs.map((s) => ({
      idx: s.idx,
      startMs: s.startMs,
      endMs: s.endMs,
      primaryText: (s.tgtTextEdited ?? s.tgtText) ?? '',
      secondaryText: s.srcTextEdited ?? s.srcText ?? undefined,
    }))

    const bilingual =
      project.config.subtitle.bilingual && project.targetLang === 'en' // PRD D13：仅中-英开双语

    const subsDir = join(ctx.projectDir, 'subs')
    await mkdir(subsDir, { recursive: true })
    const assPath = join(subsDir, 'out.ass')
    const srtPath = join(subsDir, 'out.srt')

    ctx.reportProgress(50, '生成 ASS')
    const assContent = renderAss(cues, {
      metrics,
      bilingual,
    })
    await writeFile(assPath, assContent, 'utf-8')

    ctx.reportProgress(80, '生成 SRT')
    const srtContent = renderSrt(cues, { bilingual })
    await writeFile(srtPath, srtContent, 'utf-8')

    ctx.reportProgress(
      100,
      `字幕完成 ${cues.length} 句（${bilingual ? '中-英双语' : '单语'}）`,
    )
    return {
      kind: 'ok',
      outputs: {
        ass: assPath,
        srt: srtPath,
        bilingual: String(bilingual),
        cueCount: String(cues.length),
      },
      durationMs: Date.now() - t0,
    }
  },
}

// ─── helpers ─────────────────────────────────────────────────────────

interface PreprocessMeta {
  width?: number
  height?: number
  durationMs?: number
  fps?: number
}

/**
 * 从 preprocess 阶段写的 metadata.json 里读视频实际分辨率。
 * 若读不到，用项目的 renderPreset 推断（reelshort-9x16-1080p → 1080x1920）。
 */
const readVideoMetrics = async (
  projectDir: string,
  renderPreset: string,
): Promise<{ width: number; height: number }> => {
  const metaPath = join(projectDir, 'preprocess', 'metadata.json')
  try {
    const { readFile } = await import('node:fs/promises')
    const json = JSON.parse(await readFile(metaPath, 'utf-8')) as PreprocessMeta
    if (json.width && json.height) return { width: json.width, height: json.height }
  } catch {
    /* fall through */
  }
  // 兜底
  if (renderPreset.includes('9x16-1080p')) return { width: 1080, height: 1920 }
  return { width: 1080, height: 1920 } // 短剧绝大多数都是竖屏 1080×1920
}
