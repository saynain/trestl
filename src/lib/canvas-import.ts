import type { ProjectCanvas } from '../../shared/types';
import { post } from './api';

export async function readCanvasImport(file: File): Promise<unknown> {
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose a canvas smaller than 8 MB.');
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error('Choose a valid .excalidraw file.');
  }
}

export function importCanvas(
  base: string,
  file: File,
  document: unknown,
  collectionId?: string | null,
) {
  return post<ProjectCanvas>(`${base}/import`, {
    title:
      file.name
        .replace(/\.excalidraw$/i, '')
        .trim()
        .slice(0, 240) || 'Imported canvas',
    document,
    collectionId: collectionId ?? null,
  });
}
