import type { Visibility } from './types';
export interface ProjectImportOptions {
  projects: { id: string; name: string; key: string; visibility: Visibility }[];
  assignees: Record<string, string | null>;
}
export interface ProjectImportPreview {
  options: ProjectImportOptions;
  people: { id: string; name: string }[];
  counts: Record<string, number>;
  warnings: string[];
}
export interface ProjectImportResult {
  projectId: string;
  projectIds: string[];
  itemCount: number;
}
