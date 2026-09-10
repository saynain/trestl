import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
export const cookieOf = (r: { cookies: { name: string; value: string }[] }) => {
  const c = r.cookies.find((c) => c.name === 'trestl_session')!;
  return `${c.name}=${c.value}`;
};
export async function memberSession(
  app: FastifyInstance,
  cookie: string,
  input: { name: string; email: string; password: string },
) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { cookie },
    payload: input,
  });
  assert.equal(created.statusCode, 201, created.body);
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: input.email, password: input.password },
  });
}
