// API failures already carry their wording; see the labels in api.ts.
export const messageOf = (error: unknown, fallback = 'The request could not be completed.') =>
  error instanceof Error && error.message ? error.message : fallback;
