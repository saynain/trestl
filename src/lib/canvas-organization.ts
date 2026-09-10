import type { CanvasSummary } from '../../shared/types';

export type CanvasSort = 'updated' | 'newest' | 'alphabetical';
export function organizeCanvases(
  canvases: CanvasSummary[],
  collection: string,
  query: string,
  sort: CanvasSort,
) {
  const search = query.trim().toLocaleLowerCase();
  return canvases
    .filter(
      (canvas) =>
        (collection === 'all' || (canvas.collectionId || 'unsorted') === collection) &&
        canvas.title.toLocaleLowerCase().includes(search),
    )
    .sort((a, b) => {
      const order =
        sort === 'alphabetical'
          ? a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
          : sort === 'newest'
            ? b.createdAt.localeCompare(a.createdAt)
            : b.updatedAt.localeCompare(a.updatedAt);
      return order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
}
