import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
/** First-run setup creates the shared installation. */
export async function sharedWorkspace(_app: FastifyInstance, setup: LightMyRequestResponse) {
  return setup;
}
