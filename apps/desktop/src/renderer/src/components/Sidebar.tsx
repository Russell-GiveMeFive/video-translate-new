interface Props {
  current: string
  onNavigate: (key: any) => void
}

const navItems = [
  { key: 'projects', label: '项目', icon: '📺' },
  { key: 'workbench', label: '工作台', icon: '🎬' },
  { key: 'voices', label: '音色库', icon: '🎙️' },
  { key: 'batch', label: '批量任务', icon: '📦' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export function Sidebar({ current, onNavigate }: Props): JSX.Element {
  return (
    <aside className="flex h-full w-56 flex-col border-r border-zinc-800 bg-zinc-900/50 px-3 py-5">
      <div className="mb-6 px-2 text-sm font-semibold tracking-wider text-zinc-400">
        DRAMA<span className="text-indigo-400">PRIME</span>
      </div>
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => (
          <button
            key={item.key}
            onClick={() => onNavigate(item.key)}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
              current === item.key
                ? 'bg-indigo-500/10 text-indigo-300'
                : 'text-zinc-300 hover:bg-zinc-800/60'
            }`}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="mt-auto px-2 text-xs text-zinc-500">
        2026 · 短剧译制工作站
      </div>
    </aside>
  )
}
