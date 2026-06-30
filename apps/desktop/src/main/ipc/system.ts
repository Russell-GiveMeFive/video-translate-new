import { app, dialog, Notification, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { handle, type IpcContext } from './index.js'

export const registerSystemIpc = (_ctx: IpcContext): void => {
  handle('system:ready', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    locale: app.getLocale(),
  }))

  /**
   * v0.4.12 系统级通知（macOS / Windows 原生气泡）
   * Linux 没有原生支持时会静默失败，但渲染层 toast 已经够用
   *
   * Notification.isSupported() 检查平台是否支持原生通知
   * 静默 catch：通知失败不应阻塞主流程
   */
  handle('system:notify', async (payload: { type: string; title: string; body?: string }) => {
    if (!Notification.isSupported()) return { shown: false, reason: 'platform-unsupported' }
    try {
      const n = new Notification({
        title: payload.title,
        body: payload.body,
        silent: false, // 错误类提醒应该响一下
        urgency: payload.type === 'error' ? 'critical' : 'normal',
      })
      n.show()
      return { shown: true }
    } catch (err) {
      return { shown: false, reason: String((err as Error).message ?? err) }
    }
  })

  handle('system:select-file', async (opts) => {
    const filters =
      opts.kind === 'video'
        ? [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]
        : opts.kind === 'audio'
          ? [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a'] }]
          : [{ name: 'Subtitle', extensions: ['srt', 'vtt', 'ass'] }]
    const res = await dialog.showOpenDialog({
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters,
    })
    return res.filePaths
  })

  handle('system:open-in-explorer', async (path) => {
    shell.showItemInFolder(path)
  })

  handle('system:reveal-logs', async () => {
    shell.openPath(app.getPath('logs'))
  })

  // 读项目内文件转 data URL——给 renderer 播放音频 / 显示缩略图用
  // 安全：只允许音频和图片类型；只允许特定大小（10MB 上限）
  handle('system:read-file-as-data-url', async ({ path, mimeHint }) => {
    const ext = extname(path).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    }
    const mimeType = mimeMap[ext]
    if (!mimeType) {
      throw new Error(`不支持的文件类型: ${ext}`)
    }
    if (mimeHint === 'audio' && !mimeType.startsWith('audio/')) {
      throw new Error(`期望音频文件，得到 ${mimeType}`)
    }
    if (mimeHint === 'image' && !mimeType.startsWith('image/')) {
      throw new Error(`期望图片文件，得到 ${mimeType}`)
    }
    const stats = await stat(path)
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error(`文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB > 10MB`)
    }
    const buf = await readFile(path)
    return {
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
      sizeBytes: stats.size,
      mimeType,
    }
  })
}
