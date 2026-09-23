/** Defaults for transport and bounded rendering, separate from DSP/business preferences. */
export const performancePolicy = {
  readTimeoutMs: 15_000,
  browserUpdatePollMs: 30_000,
  teamPollMs: 10_000,
  recoveryPollMs: 60_000,
  activeCollectionPollMs: 5_000,
  employeeSearchDelayMs: 200,
  employeePageSize: 100,
  cache: { entries: 80, bytes: 4 * 1024 * 1024, freshMs: 30_000 },
};
