import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Stage, StageRunContext, StageResult } from '@dramaprime/core-types'
import { asSegmentId } from '@dramaprime/core-types'
import { ProjectRepo } from '../storage/project-repo.js'
import { SegmentRepo } from '../storage/segment-repo.js'
import { requireFfmpeg, runCmd } from '../ffmpeg/index.js'

/**
 * 为每个 segment 抽一张代表帧——"工作台"面板要用。
 *
 *   抽帧时刻：segment 中点（startMs + durMs/2）
 *   分辨率：缩到 320×宽自适应（够看清谁在说话）
 *   输出：thumbs/<segmentId>.jpg + 写回 segments.thumb_path
 *
 * 依赖：preprocess（要源视频），cluster（要 segments）
 * 失败不阻塞下游——抽帧不影响后续合成。
 */
export const thumbExtractStage: Stage = {
  name: 'ocr-assist', // 暂时占用 ocr-assist 的 mock slot；位置在 cluster 之后、translate 之前
  version: 1,
  inputsFrom: ['cluster'],
  blocking: false, // 失败不阻塞下游
  retries: 1,
  kind: 'utility',

  async run(ctx: StageRunContext): Promise<StageResult> {
    const t0 = Date.now()
    const project = ProjectRepo.get(ctx.projectId as any)
    if (!existsSync(project.sourcePath)) {
      return {
        kind: 'failed',
        error: {
          code: 'user.file-not-found',
          message: `源视频不存在：${project.sourcePath}`,
          retriable: false,
        },
      }
    }
    const segs = SegmentRepo.list(ctx.projectId as any)
    if (segs.length === 0) {
      return { kind: 'skipped', reason: '没有 segments，跳过抽帧' }
    }
    const ffmpeg = requireFfmpeg()
    const thumbsDir = join(ctx.projectDir, 'thumbs')
    await mkdir(thumbsDir, { recursive: true })

    let ok = 0
    let failed = 0
    for (let i = 0; i < segs.length; i++) {
      if (ctx.signal.aborted) {
        return {
          kind: 'failed',
          error: { code: 'pipeline.aborted', message: '已取消', retriable: false },
        }
      }
      const s = segs[i]!
      const midSec = ((s.startMs + (s.endMs - s.startMs) / 2) / 1000).toFixed(3)
      const outPath = join(thumbsDir, `${s.id}.jpg`)
      const r = await runCmd(
        ffmpeg,
        [
          '-ss',
          midSec,
          '-i',
          project.sourcePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=320:-2',
          '-q:v',
          '4',
          '-y',
          outPath,
        ],
        { signal: ctx.signal },
      )
      if (r.code === 0 && existsSync(outPath)) {
        SegmentRepo.setThumb(asSegmentId(s.id), outPath)
        ok++
      } else {
        ctx.logger.warn('抽帧失败', { segId: s.id, stderr: r.stderr.slice(0, 150) })
        failed++
      }
      if ((i + 1) % 4 === 0 || i === segs.length - 1) {
        ctx.reportProgress(
          Math.round(((i + 1) / segs.length) * 100),
          `抽帧 ${i + 1}/${segs.length}`,
        )
      }
    }
    ctx.logger.info('抽帧完成', { ok, failed, total: segs.length })
    return {
      kind: 'ok',
      outputs: { thumbs: thumbsDir, ok: String(ok), failed: String(failed) },
      durationMs: Date.now() - t0,
    }
  },
}
