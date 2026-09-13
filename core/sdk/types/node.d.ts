import type { Transport } from './index';
import type { DispatchClient, StoragePort, StorageDirectory } from './index';
export function createUnixTransport(options: { socketPath: string }): Transport;
export function createPrivateTransport(options: { socketPath: string; timeoutMs?: number }): { request(value: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
export function createWorkerClient(): DispatchClient & { storage: StoragePort & { directory(kind: StorageDirectory): string } };
export function createLocalStorage(roots: Partial<Record<StorageDirectory, string>>): StoragePort & { close(): void };
