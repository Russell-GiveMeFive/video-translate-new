import { rm } from 'node:fs/promises'
import { handle, type IpcContext } from './index.js'
import { ProjectRepo } from '../storage/project-repo.js'
import { getProjectDir } from '../orchestrator/index.js'

export const registerProjectIpc = (_ctx: IpcContext): void => {
  handle('project:create', async (input) => ProjectRepo.create(input))
  handle('project:list', async (filter) => ProjectRepo.list(filter))
  handle('project:get', async (id) => ProjectRepo.get(id))
  // v0.4.12 删除项目：DB + 磁盘目录一起清
  // 源视频不在项目目录里，删除项目不影响源文件
  handle('project:delete', async (id) => {
    ProjectRepo.delete(id)
    try {
      await rm(getProjectDir(id), { recursive: true, force: true })
    } catch {
      /* 目录可能本来就不存在，忽略 */
    }
  })
  handle('project:duplicate', async (_id) => {
    throw new Error('project:duplicate 待实现（v0.1 stub）')
  })
  handle('project:import', async (_path) => {
    throw new Error('project:import 待实现（v0.1 stub）')
  })
  handle('project:export', async (_input) => {
    throw new Error('project:export 待实现（v0.1 stub）')
  })
}
