/** What `/api/platform/diagnostics` answers with. */
export interface Diagnostics {
  enabled: boolean;
  storageAvailableBytes: number;
  runtime: { name: string; status: string; memoryBytes: number; browsers: number };
  dsps: { id: string; name: string; status: string }[];
}
