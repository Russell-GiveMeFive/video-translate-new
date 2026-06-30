/**
 * 火山引擎流式 ASR WebSocket 自定义二进制协议编解码器。
 *
 * 协议来源：https://www.volcengine.com/docs/6561/1354869
 *
 * 帧结构（所有 int 字段大端）：
 *
 *   [Header 4 字节]
 *     byte 0: protocol_version(4) | header_size(4)   //  0x11 = v1 + size 4 字节
 *     byte 1: message_type(4)     | flags(4)
 *     byte 2: serialization(4)    | compression(4)
 *     byte 3: reserved (0x00)
 *
 *   [Sequence 4 字节, optional] —— flags 高位指示是否带 sequence
 *   [Payload size 4 字节, uint32 BE]
 *   [Payload N 字节]  —— 按 compression 字段压缩；按 serialization 序列化
 *
 *   注：Server Error 帧的"sequence 槽"实际是 error_code（uint32 BE）
 */

import { gzipSync, gunzipSync } from 'node:zlib'

// ── 常量枚举 ─────────────────────────────────────────────────────────
export const PROTOCOL_VERSION = 0b0001
export const HEADER_SIZE_4B = 0b0001 // 实际字节数 = value * 4

export enum MessageType {
  FullClientRequest = 0b0001,
  AudioOnlyRequest = 0b0010,
  FullServerResponse = 0b1001,
  ServerError = 0b1111,
}

/** Message type specific flags（用于声明序列号、负包等） */
export enum MessageFlags {
  /** header 后 4 字节**不是** sequence */
  None = 0b0000,
  /** header 后 4 字节为正 sequence */
  PositiveSequence = 0b0001,
  /** header 后**没有 sequence**，仅指示这是最后一包 */
  LastPacketNoSeq = 0b0010,
  /** header 后 4 字节为**负 sequence**，表示最后一包（负包） */
  LastPacketNegSeq = 0b0011,
}

export enum Serialization {
  None = 0b0000,
  Json = 0b0001,
}

export enum Compression {
  None = 0b0000,
  Gzip = 0b0001,
}

// ── 编码（client → server） ──────────────────────────────────────────

export interface EncodeOpts {
  messageType: MessageType
  flags: MessageFlags
  serialization?: Serialization
  compression?: Compression
  /** 当 flags 指示带 sequence 时使用；负 sequence 表示最后一包 */
  sequence?: number
  /** Payload 原始内容（未压缩、未序列化） */
  payload: Buffer | object
}

/** 把一个完整帧编码为 Buffer，准备 ws.send() */
export function encodeFrame(opts: EncodeOpts): Buffer {
  const ser = opts.serialization ?? Serialization.Json
  const comp = opts.compression ?? Compression.Gzip

  // 1. 准备 payload
  let raw: Buffer
  if (Buffer.isBuffer(opts.payload)) {
    raw = opts.payload
  } else if (ser === Serialization.Json) {
    raw = Buffer.from(JSON.stringify(opts.payload), 'utf-8')
  } else {
    throw new Error('encodeFrame: payload 不是 Buffer 但 serialization 非 JSON')
  }

  const compressed = comp === Compression.Gzip ? gzipSync(raw) : raw

  // 2. 构造 header (4 bytes)
  const header = Buffer.alloc(4)
  header[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_4B
  header[1] = (opts.messageType << 4) | opts.flags
  header[2] = (ser << 4) | comp
  header[3] = 0x00

  // 3. 可选 sequence (4 bytes BE int32)
  const includeSeq =
    opts.flags === MessageFlags.PositiveSequence ||
    opts.flags === MessageFlags.LastPacketNegSeq
  let seqBuf = Buffer.alloc(0)
  if (includeSeq) {
    if (opts.sequence == null) {
      throw new Error('encodeFrame: flags 要求带 sequence 但 opts.sequence 未传')
    }
    seqBuf = Buffer.alloc(4)
    seqBuf.writeInt32BE(opts.sequence, 0)
  }

  // 4. payload size (4 bytes BE uint32)
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(compressed.length, 0)

  return Buffer.concat([header, seqBuf, sizeBuf, compressed])
}

/** 便捷：full client request（JSON 配置帧），sequence = 1 */
export const encodeFullClientRequest = (config: object, sequence = 1): Buffer =>
  encodeFrame({
    messageType: MessageType.FullClientRequest,
    flags: MessageFlags.PositiveSequence,
    serialization: Serialization.Json,
    compression: Compression.Gzip,
    sequence,
    payload: config,
  })

/** 便捷：audio chunk（二进制音频帧），sequence ≥ 2，最后一包 sequence 取负 */
export const encodeAudioChunk = (
  pcm: Buffer,
  sequence: number,
  isLast: boolean,
): Buffer =>
  encodeFrame({
    messageType: MessageType.AudioOnlyRequest,
    flags: isLast ? MessageFlags.LastPacketNegSeq : MessageFlags.PositiveSequence,
    serialization: Serialization.None,
    compression: Compression.Gzip,
    sequence: isLast ? -Math.abs(sequence) : sequence,
    payload: pcm,
  })

// ── 解码（server → client） ──────────────────────────────────────────

export interface DecodedFrame {
  messageType: MessageType
  flags: MessageFlags
  serialization: Serialization
  compression: Compression
  /** 仅当 flags 指示带 sequence 时存在；ServerError 时是 error_code */
  sequence?: number
  errorCode?: number
  /** 解压 + 反序列化后的 JSON 对象（如果是 JSON 帧）；否则 raw Buffer */
  payload?: Record<string, unknown> | Buffer | string
  /** 原始 payload 字节（便于调试） */
  rawPayloadBytes: Buffer
}

export function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.length < 4) {
    throw new Error(`decodeFrame: 帧太短 (${buf.length} bytes)`)
  }
  const headerSizeBytes = (buf[0]! & 0x0f) * 4
  if (headerSizeBytes !== 4) {
    throw new Error(`decodeFrame: 不支持的 header_size=${headerSizeBytes}`)
  }
  const messageType = ((buf[1]! >> 4) & 0x0f) as MessageType
  const flags = (buf[1]! & 0x0f) as MessageFlags
  const serialization = ((buf[2]! >> 4) & 0x0f) as Serialization
  const compression = (buf[2]! & 0x0f) as Compression

  let cursor = 4
  let sequence: number | undefined
  let errorCode: number | undefined

  if (messageType === MessageType.ServerError) {
    // Error 帧布局：header + error_code(4B BE uint32) + payload_size(4B) + payload
    errorCode = buf.readUInt32BE(cursor)
    cursor += 4
  } else {
    const includeSeq =
      flags === MessageFlags.PositiveSequence ||
      flags === MessageFlags.LastPacketNegSeq
    if (includeSeq) {
      sequence = buf.readInt32BE(cursor)
      cursor += 4
    }
  }

  if (buf.length < cursor + 4) {
    throw new Error(`decodeFrame: payload_size 字段缺失`)
  }
  const payloadSize = buf.readUInt32BE(cursor)
  cursor += 4

  if (buf.length < cursor + payloadSize) {
    throw new Error(
      `decodeFrame: payload 长度不足 (need=${payloadSize}, have=${buf.length - cursor})`,
    )
  }
  const rawPayloadBytes = buf.subarray(cursor, cursor + payloadSize)
  let decompressed: Buffer
  try {
    decompressed = compression === Compression.Gzip ? gunzipSync(rawPayloadBytes) : rawPayloadBytes
  } catch (err) {
    throw new Error(`decodeFrame: gunzip 失败: ${(err as Error).message}`)
  }

  let payload: DecodedFrame['payload']
  if (serialization === Serialization.Json) {
    const text = decompressed.toString('utf-8')
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      payload = text
    }
  } else {
    payload = decompressed
  }

  return {
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    errorCode,
    payload,
    rawPayloadBytes,
  }
}
