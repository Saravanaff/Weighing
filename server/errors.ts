export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export const httpError = (status: number, message: string): HttpError => new HttpError(status, message);

export const errorStatus = (err: unknown, fallback: number): number =>
  err instanceof HttpError ? err.status : fallback;

export const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

export default {};
