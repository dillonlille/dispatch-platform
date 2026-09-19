/** Retry delay after `failures` consecutive failures: 1s doubling to 15s. */
export const backoff = (failures: number) => Math.min(15000, 1000 * 2 ** Math.min(failures, 4));
