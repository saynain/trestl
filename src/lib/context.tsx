import { createContext, useContext } from 'react';
import type { ItemAction } from './shortcuts';
import type { UiPreferences } from './preferences';
import type { Bootstrap, Project, Status, WorkItem } from '../../shared/types';
export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}
export interface AppContextValue {
  data: Bootstrap;
  refresh: () => Promise<void>;
  toast: (message: string, kind?: 'success' | 'error') => void;
  toastAction: (message: string, action: ToastAction, kind?: 'success' | 'error') => void;
  applyItems: (items: WorkItem[]) => void;
  removeItems: (ids: string[]) => void;
  openItem: (id: string, action?: ItemAction) => void;
  createItem: (projectId?: string | null, status?: Status, parentId?: string) => void;
  createProject: (parentId?: string) => void;
  editProject: (project: Project) => void;
  uiPreferences: UiPreferences;
  updateUiPreferences: (changes: Partial<UiPreferences>) => void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('Missing application context');
  return ctx;
}
