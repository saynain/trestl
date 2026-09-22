import { openapi } from '../../../../server/openapi';

export const prerender = true;
export function GET() {
  return new Response(JSON.stringify(openapi, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
