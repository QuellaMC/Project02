/** The platform's fetch says `fetch failed` and keeps the reason in `cause`. */
export function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.cause instanceof Error
    ? `${error.message}: ${error.cause.message}`
    : error.message;
}
