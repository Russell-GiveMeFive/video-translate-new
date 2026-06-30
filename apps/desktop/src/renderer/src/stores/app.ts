import { create } from 'zustand'
import type { ProjectId, ProjectSummary, StageName } from '@dramaprime/core-types'

export type SysInfo = { version: string; platform: string; locale: string }

interface ProjectProgress {
  stage: StageName
  percent: number
  message?: string
  costTotalCents: number
}

interface AppState {
  sysInfo: SysInfo | null
  setSysInfo: (info: SysInfo) => void

  currentProjectId: ProjectId | null
  setCurrentProjectId: (id: ProjectId | null) => void

  projects: ProjectSummary[]
  setProjects: (items: ProjectSummary[]) => void

  progress: Record<ProjectId, ProjectProgress>
  patchProgress: (id: ProjectId, patch: Partial<ProjectProgress>) => void
}

export const useAppStore = create<AppState>((set) => ({
  sysInfo: null,
  setSysInfo: (info) => set({ sysInfo: info }),

  currentProjectId: null,
  setCurrentProjectId: (id) => set({ currentProjectId: id }),

  projects: [],
  setProjects: (items) => set({ projects: items }),

  progress: {},
  patchProgress: (id, patch) =>
    set((s) => ({
      progress: {
        ...s.progress,
        [id]: {
          stage: patch.stage ?? s.progress[id]?.stage ?? 'preprocess',
          percent: patch.percent ?? s.progress[id]?.percent ?? 0,
          message: patch.message ?? s.progress[id]?.message,
          costTotalCents:
            patch.costTotalCents ?? s.progress[id]?.costTotalCents ?? 0,
        },
      },
    })),
}))
