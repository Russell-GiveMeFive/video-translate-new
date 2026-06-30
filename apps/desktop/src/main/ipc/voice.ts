import type { VoiceAsset, ProjectId } from '@dramaprime/core-types'
import { handle, type IpcContext } from './index.js'
import { VoiceAssetRepo } from '../storage/voice-asset-repo.js'
import { ProjectRepo } from '../storage/project-repo.js'

/**
 * v0.4.12 音色资产库 IPC
 *
 * 数据流：
 *   voice-clone 成功 → CharacterRepo.setVoice() + VoiceAssetRepo.record()
 *   用户在 voices 页面：list / 改名 / 删除（从库移除）
 *   新建项目引用 voice_id：可从库查来源 / 默认名（只读展示，不影响历史项目）
 */
export const registerVoiceIpc = (_ctx: IpcContext): void => {
  handle('voice:list', async (): Promise<VoiceAsset[]> => {
    const rows = VoiceAssetRepo.list()
    // 顺便关联项目名（用于 UI 展示「来自：xxx」）
    return rows.map((r) => {
      const project = ProjectRepo.get(r.originProjectId as ProjectId)
      return {
        id: r.id,
        name: r.name,
        voiceId: r.voiceId,
        provider: r.provider as 'MiniMax',
        // v0.4.12 voice_id 是 MiniMax 7 天临时音色，标记为 temp
        status: r.status as 'temp',
        expiresAt: r.expiresAt,
        // ★ tags 里附带"来自哪个项目 + 哪个角色"，UI 渲染用
        tags: [
          `from:${project?.name ?? '(已删除项目)'}`,
          ...r.tags,
        ],
        originProjectId: r.originProjectId as ProjectId,
        samplePath: r.samplePath,
        createdAt: r.createdAt,
      }
    })
  })

  handle('voice:rename', async (input: { voiceId: string; name: string }) => {
    VoiceAssetRepo.rename(input.voiceId as any, input.name)
  })

  handle('voice:delete', async (input: { voiceId: string }) => {
    // 只从音色库移除——不动其他项目对 voice_id 的引用
    // voice_id 是 MiniMax 服务端对象，删除本地记录 ≠ 实际删除远端音色
    VoiceAssetRepo.remove(input.voiceId as any)
  })
}