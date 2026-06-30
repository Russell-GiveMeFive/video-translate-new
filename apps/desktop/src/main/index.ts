import { app, BrowserWindow, shell, protocol, net } from 'electron'
import { fileURLToPath } from 'node:url'
import { join, dirname, isAbsolute, resolve as pathResolve } from 'node:path'
import { existsSync } from 'node:fs'
import { initLogger, logger } from './logger.js'
import { initStorage, closeStorage } from './storage/index.js'
import { registerAllIpc } from './ipc/index.js'
import { initOrchestrator, stopAllPipelines } from './orchestrator/index.js'
import { initProviders } from './providers/index.js'
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// ─── 单实例锁 ─────────────────────────────────────────────────────────
// 用稳定的产品名，避免 dev 模式下 userData 落到 "Electron" 目录
app.setName('DramaPrime')
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// ─── 自定义 app:// 协议（v0.1 安全读本地文件） ─────────────────────────
const ALLOWED_ROOTS: string[] = [] // 启动后写入 userData 子路径

const resolveSafe = (urlPath: string): string | null => {
  const normalized = pathResolve(decodeURIComponent(urlPath))
  if (!isAbsolute(normalized)) return null
  return ALLOWED_ROOTS.some((r) => normalized.startsWith(r)) ? normalized : null
}

const registerAppProtocol = () => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    const p = resolveSafe(url.pathname)
    if (!p) return new Response('forbidden', { status: 403 })
    if (!existsSync(p)) return new Response('not found', { status: 404 })
    return net.fetch(`file://${p}`)
  })
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 把 renderer 的 console + 错误转发到 main 终端，方便 dev 排查白屏 / 黑屏
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error', 'info'][level] ?? 'log'
    logger.info({ tag, line, sourceId }, `[renderer] ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error({ details }, 'renderer process gone')
  })
  mainWindow.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL) => {
      logger.error({ errorCode, errorDescription, validatedURL }, 'renderer failed to load')
    },
  )

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // ── 初始化基础设施 ─────────────────
  initLogger(app.getPath('logs'))
  logger.info({ version: app.getVersion(), platform: process.platform }, 'app starting')

  // 启动时尝试解析 ffmpeg 路径，便于 dev 期立刻知道用的是哪个 ffmpeg
  try {
    logger.info(
      { ffmpeg: resolveFfmpeg(), ffprobe: resolveFfprobe() },
      'ffmpeg binaries resolved',
    )
  } catch (err) {
    logger.warn({ err: String(err) }, 'ffmpeg resolution failed')
  }

  const userData = app.getPath('userData')
  ALLOWED_ROOTS.push(join(userData, 'projects'), join(userData, 'cache'))

  await initStorage(join(userData, 'projects.db'))

  const providers = await initProviders()
  initOrchestrator({ projectsDir: join(userData, 'projects'), providers })

  registerAppProtocol()
  registerAllIpc({ getMainWindow: () => mainWindow })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  logger.info('app quitting, cleaning up')
  e.preventDefault()
  try {
    await stopAllPipelines()
    await closeStorage()
  } catch (err) {
    logger.error({ err }, 'shutdown error')
  }
  app.exit(0)
})
