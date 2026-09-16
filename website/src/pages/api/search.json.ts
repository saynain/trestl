import { createSearchAPI } from 'fumadocs-core/search/server';
import { loadDocs } from '../../lib/docs';
import { docUrl } from '../../lib/docs-manifest';

export const prerender = true;
export async function GET() {
  const docs = await loadDocs();
  const search = createSearchAPI('advanced', {
    indexes: docs.map(doc => ({ id: doc.slug, title: doc.title, description: doc.description, url: docUrl(doc.slug), structuredData: doc.structuredData })),
  });
  return search.staticGET();
}
