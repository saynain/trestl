export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 'request_error',
    readonly exitCode = 1,
    readonly status?: number,
  ) {
    super(message);
  }
}
export const usage = (message: string) => new CliError(message, 'usage_error', 2);
export function httpError(status: number, message: string): CliError {
  const mapping: Record<number, [string, number]> = {
    400: ['validation_error', 2],
    401: ['unauthorized', 3],
    403: ['forbidden', 3],
    404: ['not_found', 4],
    409: ['conflict', 5],
    429: ['rate_limited', 6],
  };
  const [code, exitCode] = mapping[status] || [
    status >= 500 ? 'server_error' : 'request_error',
    status >= 500 ? 6 : 1,
  ];
  return new CliError(message, code, exitCode, status);
}
