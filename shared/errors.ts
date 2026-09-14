export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message = code.replaceAll('_', ' '),
  ) {
    super(message);
  }
}
export function assert(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new AppError(code, status);
}
export function safeError(error: unknown): string {
  return error instanceof AppError ? error.code : 'operation_failed';
}
