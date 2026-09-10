import { createPrivateKey, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { encryptToken, decryptToken } from './integration-provider.ts';
import { type GitConnection, publicGitConnection } from './git-connections.ts';
import { workspaceOf } from './workspaces.ts';
const secret = () => process.env.APP_SECRET ?? '';
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
export async function installationCredential(ctx: AppContext, c: GitConnection) {
  const saved = c.githubInstallation!;
  const payload = encode({
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 540,
    iss: saved.appId,
  });
  const signing = `${encode({ alg: 'RS256', typ: 'JWT' })}.${payload}`;
  const jwt = sign(
    'RSA-SHA256',
    Buffer.from(signing),
    createPrivateKey(decryptToken(saved.encryptedPrivateKey, secret(), c.id)),
  ).toString('base64url');
  const headers = {
    Authorization: `Bearer ${signing}.${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const transport = ctx.githubFetch ?? fetch;
  const response = await transport(
    `https://api.github.com/app/installations/${saved.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { issues: 'read', metadata: 'read' } }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );
  if (!response.ok)
    ctx.fail(
      502,
      'GitHub App authentication failed. Check the installation ID, App ID, private key, and repository permissions.',
    );
  const parsed = z
    .object({
      token: z.string().min(1),
      expires_at: z.string(),
      repository_selection: z.enum(['all', 'selected']).optional(),
    })
    .safeParse(await response.json());
  if (!parsed.success) ctx.fail(502, 'GitHub returned an invalid installation credential.');
  return { connection: c, token: parsed.data.token };
}
export function registerGitHubInstallation(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/v1/admin/github-installation', async (request, reply) => {
    const user = ctx.requireUser(request);
    if (user.role !== 'admin' || request.tokenScope)
      ctx.fail(403, 'Administrator browser access is required.');
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        appId: z.string().regex(/^\d+$/),
        installationId: z.string().regex(/^\d+$/),
        privateKey: z.string().max(20000).min(100),
      })
      .strict()
      .parse(request.body);
    if (secret().length < 32)
      ctx.fail(503, 'Set a durable APP_SECRET before storing integration credentials.');
    try {
      createPrivateKey(input.privateKey);
    } catch {
      ctx.fail(400, 'Enter a valid GitHub App private key in PEM format.');
    }
    const connection: GitConnection = {
      id: ctx.id(),
      userId: user.id,
      workspaceId: workspaceOf(user),
      shared: true,
      name: input.name,
      provider: 'github',
      baseUrl: 'https://api.github.com',
      encryptedToken: '',
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
    connection.githubInstallation = {
      appId: input.appId,
      installationId: input.installationId,
      encryptedPrivateKey: encryptToken(input.privateKey, secret(), connection.id),
    };
    await installationCredential(ctx, connection);
    await ctx.store.put('gitConnections', connection);
    return reply.code(201).send(publicGitConnection(connection));
  });
}
