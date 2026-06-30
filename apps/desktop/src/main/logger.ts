import { join } from 'node:path'
import { existsSync, mkdirSync, createWriteStream } from 'node:fs'
import { Writable } from 'node:stream'
import pino, { multistream } from 'pino'

let _logger: pino.Logger | undefined

const REDACT_PATHS = [
  '*.apiKey',
  '*.api_key',
  '*.access_token',
  '*.authorization',
  'req.headers.authorization',
]

/**
 * 把 pino 的 JSON 输出实时翻译成人类可读文本到独立 .log.txt 文件
 * 格式：HH:MM:SS.mmm [LEVEL] message { key=value ... }
 *
 * pino 没有原生 pretty 输出（避免 worker thread 依赖）；
 * 我们自己在 streams 层加一个 Writable，level-aware。
 */
class HumanReadableStream extends Writable {
  constructor(private readonly out: NodeJS.WritableStream) {
    super({ decodeStrings: false })
  }
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    try {
      const line = chunk.toString('utf8').trimEnd()
      if (!line) return cb()
      // pino multistream 每行就是一个 JSON object
      const obj = JSON.parse(line)
      const t = new Date(obj.time ?? Date.now())
      const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
      const stamp =
        `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${String(t.getMilliseconds()).padStart(3, '0')}`
      const level =
        obj.level === 50
          ? 'ERROR'
          : obj.level === 40
            ? 'WARN'
            : obj.level === 30
              ? 'INFO'
              : 'DEBUG'
      const { msg, ...rest } = obj
      const tail = Object.keys(rest).length
        ? ' ' +
          Object.entries(rest)
            .filter(([k]) => !['pid', 'hostname', 'time', 'level', 'msg', 'v'].includes(k))
            .map(([k, v]) => {
              if (typeof v === 'object' && v !== null) return `${k}=${JSON.stringify(v)}`
              return `${k}=${v}`
            })
            .join(' ')
        : ''
      this.out.write(`[${stamp}] [${level}] ${msg}${tail}\n`)
    } catch (err) {
      // 解析失败 → 写原文（防止丢日志）
      this.out.write(chunk.toString('utf8'))
    }
    cb()
  }
}

export const initLogger = (logsDir: string): void => {
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const jsonFile = join(logsDir, `${date}.log`)
  const textFile = join(logsDir, `${date}.log.txt`)

  // v0.4.14 三路输出：
  //   1. JSON 文件（开发者调试用，结构化）
  //   2. .log.txt 人类可读副本（客户 / 客服看用）
  //   3. stdout（dev 模式 main 终端直接看）
  const textOut = createWriteStream(textFile, { flags: 'a' })
  const streams = [
    { level: 'info' as const, stream: pino.destination({ dest: jsonFile, sync: false, mkdir: true }) },
    { level: 'info' as const, stream: new HumanReadableStream(textOut) },
    { level: 'debug' as const, stream: process.stdout },
  ]

  _logger = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    multistream(streams, { dedupe: false }),
  )
}

export const logger = new Proxy({} as pino.Logger, {
  get(_t, prop) {
    if (!_logger) throw new Error('logger not initialized; call initLogger first')
    return (_logger as any)[prop]
  },
})

/**
 * v0.4.14 便利 API：打印一条 stage 边界（人类可读日志里多空行 + 大写标题）
 *
 * 用法：logStageBoundary('translate', '开始')
 *      logStageBoundary('translate', '完成', { costCents: 12 })
 */
export const logStageBoundary = (
  stage: string,
  status: '开始' | '完成' | '失败',
  extra?: Record<string, unknown>,
): void => {
  const detail = extra ? ` ${JSON.stringify(extra)}` : ''
  logger.info(`━━━ ${stage} ${status} ━━━${detail}`)
}
