import { useEffect, useState } from 'react'

/**
 * v0.4.12 全局 Toast 组件 —— 推送 pipeline 关键事件给用户
 *
 * 用法：
 *   1. <ToastContainer /> 挂在 App.tsx 顶层
 *   2. 任意子组件 useToast() 拿到 push() 调 push({type:'error', message:'...'})
 *
 * 设计要点：
 *   - 自动 5s 消失（可手动延长）
 *   - error/warn 持续到用户点击关闭
 *   - 多 toast 堆叠（右下方）
 *   - 不依赖 OS 通知权限（任何平台都能用）
 *   - 同时也调 main 进程发系统气泡（如果 OS 权限允许）
 */

export type ToastType = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  /** 是否可关闭（true 显示关闭按钮；error 默认可关闭，info 默认自动消失） */
  dismissible?: boolean
  /** 自动消失时间（ms），0 = 不自动消失 */
  autoCloseMs?: number
}

interface ToastContainerState {
  toasts: Toast[]
}

// 简易全局单例（避免引入 redux/zustand 这类重型状态管理）
type Listener = (toasts: Toast[]) => void
const _toasts: Toast[] = []
const _listeners: Set<Listener> = new Set()

const emit = (): void => {
  for (const l of _listeners) l(_toasts)
}

export const pushToast = (
  type: ToastType,
  title: string,
  message?: string,
  opts?: { autoCloseMs?: number; dismissible?: boolean },
): string => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const toast: Toast = {
    id,
    type,
    title,
    message,
    dismissible: opts?.dismissible ?? (type === 'error' || type === 'warn'),
    autoCloseMs: opts?.autoCloseMs ?? (type === 'info' || type === 'success' ? 5000 : 0),
  }
  _toasts.push(toast)
  // 触发系统通知（让用户在切走页面时也能看到）
  void pushSystemNotification(type, title, message).catch(() => {
    /* 系统通知失败不影响 toast 显示 */
  })
  emit()
  return id
}

export const dismissToast = (id: string): void => {
  const i = _toasts.findIndex((t) => t.id === id)
  if (i >= 0) {
    _toasts.splice(i, 1)
    emit()
  }
}

const pushSystemNotification = async (
  type: ToastType,
  title: string,
  message?: string,
): Promise<void> => {
  // macOS / Windows 系统气泡通知
  const body = message ? `${title}\n${message}` : title
  // 通过 IPC 调 main 进程发系统通知（main 那边用 Electron Notification API）
  try {
    await window.api.invoke('system:notify', { type, title, body } as any)
  } catch {
    /* 静默失败 —— 渲染层 toast 已足够 */
  }
}

export function ToastContainer(): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>(_toasts)
  useEffect(() => {
    const l: Listener = (t) => setToasts([...t])
    _listeners.add(l)
    return () => {
      _listeners.delete(l)
    }
  }, [])

  // 每秒检查一次自动消失
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      const filtered = _toasts.filter((t) => {
        if (!t.autoCloseMs) return true
        const age = now - parseInt(t.id.split('-')[0] ?? '0', 10)
        return age < t.autoCloseMs
      })
      if (filtered.length !== _toasts.length) {
        _toasts.length = 0
        _toasts.push(...filtered)
        emit()
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const STYLES: Record<ToastType, string> = {
    info: 'border-sky-500/40 bg-sky-500/10 text-sky-100',
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100',
    warn: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
    error: 'border-rose-500/40 bg-rose-500/10 text-rose-100',
  }
  const ICONS: Record<ToastType, string> = {
    info: 'ℹ',
    success: '✓',
    warn: '⚠',
    error: '✗',
  }
  return (
    <div
      className={`pointer-events-auto rounded-lg border p-3 shadow-lg backdrop-blur ${STYLES[toast.type]}`}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <span className="text-base font-bold">{ICONS[toast.type]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold">{toast.title}</div>
          {toast.message && (
            <div className="mt-1 whitespace-pre-wrap break-words text-[11px] opacity-90">
              {toast.message}
            </div>
          )}
        </div>
        {toast.dismissible && (
          <button
            onClick={() => dismissToast(toast.id)}
            className="ml-1 text-lg leading-none opacity-60 hover:opacity-100"
            title="关闭"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

/** 便捷 API：业务代码用一行调用 */
export const toast = {
  info: (title: string, message?: string): string => pushToast('info', title, message),
  success: (title: string, message?: string): string => pushToast('success', title, message),
  warn: (title: string, message?: string): string => pushToast('warn', title, message),
  error: (title: string, message?: string): string => pushToast('error', title, message),
  dismiss: dismissToast,
}