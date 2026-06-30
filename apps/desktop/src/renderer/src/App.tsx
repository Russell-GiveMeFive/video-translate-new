import { useEffect, useState } from 'react'
import { ProjectList } from './pages/ProjectList.js'
import { Workbench } from './pages/Workbench.js'
import { Settings } from './pages/Settings.js'
import { Sidebar } from './components/Sidebar.js'
import { ToastContainer } from './components/Toast.js'  // v0.4.12 全局 toast
import { useAppStore } from './stores/app.js'
import { Voices } from './pages/Voices.js'  // v0.4.12 音色库（替换 stub）

type Route = 'projects' | 'workbench' | 'voices' | 'batch' | 'settings'

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>('projects')
  const sysInfo = useAppStore((s) => s.sysInfo)
  const setSysInfo = useAppStore((s) => s.setSysInfo)

  useEffect(() => {
    void window.api.invoke('system:ready').then((res) => {
      if (res.ok) setSysInfo(res.data)
    })
  }, [setSysInfo])

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-zinc-100">
      <Sidebar current={route} onNavigate={setRoute} />
      <main className="flex-1 overflow-hidden">
        {route === 'projects' && <ProjectList onOpen={() => setRoute('workbench')} />}
        {route === 'workbench' && <Workbench />}
        {route === 'voices' && <Voices />}
        {route === 'batch' && <div className="p-8">批量任务（v0.1 stub）</div>}
        {route === 'settings' && <Settings />}
      </main>
      <div className="absolute bottom-2 right-3 text-xs text-zinc-500">
        v{sysInfo?.version ?? '?'} · {sysInfo?.platform ?? '?'}
      </div>
      <ToastContainer />
    </div>
  )
}
