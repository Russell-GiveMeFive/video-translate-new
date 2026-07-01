import { app, BrowserWindow, shell, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import { join, dirname, isAbsolute, resolve as pathResolve, extname } from 'node:path'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { initLogger, logger } from './logger.js'
import { initStorage, closeStorage } from './storage/index.js'
import { registerAllIpc } from './ipc/index.js'
import { initOrchestrator, stopAllPipelines } from './orchestrator/index.js'
import { initProviders } from './providers/index.js'
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// ─── app:// 特权声明（必须在 app.whenReady 之前调用） ──────────────────
// 关键：stream=true 让 <video src="app://..."> 能做 Range Request（否则视频无法 seek/播放）
// standard=true 让 URL 走标准解析规则（否则 pathname 有 host 时会怪异）
// secure=true 让页面 origin 一致时可访问；supportFetchAPI=true 让 fetch()/net.fetch 可用
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

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
// - ALLOWED_ROOTS：常驻白名单（userData/projects, userData/cache）—— 项目产物目录，安全
// - allowedSingleFiles：临时单文件白名单（v0.5 预处理 tab 播放源视频用）
//   用户可能选任意路径的 mp4，不能整个 fs 开放；每次只放行"当前项目源视频"一个绝对路径。
//
// URL 结构：app://local/<绝对路径>
//   - 固定 host "local"：Chromium 在 standard scheme 下要求合法 host
//   - pathname 就是绝对路径（含开头的 /），resolveSafe 直接拿来判定
const ALLOWED_ROOTS: string[] = []
const allowedSingleFiles = new Set<string>()

const resolveSafe = (urlPath: string): string | null => {
  const normalized = pathResolve(decodeURIComponent(urlPath))
  if (!isAbsolute(normalized)) return null
  if (ALLOWED_ROOTS.some((r) => normalized.startsWith(r))) return normalized
  if (allowedSingleFiles.has(normalized)) return normalized
  return null
}

/** 把绝对路径编码成 app://local/... URL，供 renderer 消费 */
const toAppUrl = (absPath: string): string => {
  const norm = pathResolve(absPath)
  // encodeURI 保留 / 分隔符，但转义空格 / 中文 / 特殊字符
  const encoded = norm.split('/').map(encodeURIComponent).join('/')
  return `app://local${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * v0.5 允许 renderer 通过 app:// 播源视频（每个项目只放行自己那一个文件）。
 * 切换项目时先 clear 再 add，防止越权。返回可直接塞给 <video src> 的 URL。
 */
export const registerSourcePreview = (absPath: string): string => {
  allowedSingleFiles.clear()
  const normalized = pathResolve(absPath)
  allowedSingleFiles.add(normalized)
  return toAppUrl(normalized)
}

/** v0.5 项目内产物路径 → app:// URL（缩略图等） */
export const toProjectAssetUrl = (absPath: string): string => toAppUrl(absPath)

const registerAppProtocol = () => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    const p = resolveSafe(url.pathname)
    if (!p) {
      logger.warn({ url: req.url }, 'app:// forbidden')
      return new Response('forbidden', { status: 403 })
    }
    if (!existsSync(p)) return new Response('not found', { status: 404 })

    // ── Range Request 支持（视频 seek / 增量缓冲必须） ───────────────
    // Chromium 请求视频时会带 Range: bytes=X-Y；不返 206 + Content-Range
    // 就会拿到偏移错误的字节 → 解码到某个包对不上就 PIPELINE_ERROR_DECODE
    let size: number
    try {
      size = statSync(p).size
    } catch {
      return new Response('stat failed', { status: 500 })
    }
    const mime = mimeOf(p)
    const rangeHeader = req.headers.get('range')

    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m) {
        const startRaw = m[1]
        const endRaw = m[2]
        let start = startRaw ? Number(startRaw) : 0
        let end = endRaw ? Number(endRaw) : size - 1
        // suffix form "bytes=-N"：最后 N 字节
        if (!startRaw && endRaw) {
          start = Math.max(0, size - Number(endRaw))
          end = size - 1
        }
        if (start > end || start >= size) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          })
        }
        end = Math.min(end, size - 1)
        const chunkSize = end - start + 1
        // Node ReadStream → Web ReadableStream（Response body 要 Web 流）
        const nodeStream = createReadStream(p, { start, end })
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
          },
        })
      }
    }

    // 无 Range —— 整个文件（带 Accept-Ranges 让 Chromium 知道以后可以发 Range）
    const nodeStream = createReadStream(p)
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream
    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    })
  })
}

const mimeOf = (p: string): string => {
  const ext = extname(p).toLowerCase()
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.webm':
      return 'video/webm'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    case '.json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
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
