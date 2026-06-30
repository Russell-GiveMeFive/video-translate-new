import { handle, type IpcContext } from './index.js'
import { CharacterRepo } from '../storage/index.js'
import { asCharacterId } from '@dramaprime/core-types'
import { recloneExtended } from '../orchestrator/reclone-extended.js'

export const registerCharacterIpc = (ctx: IpcContext): void => {
  handle('character:list', async ({ projectId }) => CharacterRepo.list(projectId))

  handle('character:rename', async ({ characterId, name }) => {
    CharacterRepo.rename(asCharacterId(characterId), name)
  })

  /**
   * v0.4.16 切换"使用原音"开关
   * UI: Workstation 角色详情面板"使用原音"按钮
   */
  handle('character:set-use-original-audio', async ({ characterId, useOriginalAudio }) => {
    CharacterRepo.setUseOriginalAudio(asCharacterId(characterId), !!useOriginalAudio)
  })

  /**
   * v0.4.19 "复制并复刻" IPC 保留作回归/调试入口；
   * UI 按钮已下线，正常流程由 voice-clone-stage 自动 fallback 调用。
   */
  handle('character:reclone-extended', async ({ characterId, projectId }) =>
    recloneExtended(characterId, projectId),
  )

  handle('character:reclone', async (_input) => {
    // v0.2 阶段：标记后让用户重跑 voice-clone stage
    throw new Error('character:reclone 待实现：v0.2 阶段请重跑整集 pipeline 触发重克隆')
  })
}
