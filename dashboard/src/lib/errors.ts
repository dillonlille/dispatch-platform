// API failures already carry their wording; see the labels in api.ts.
export const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'The request could not be completed.';
