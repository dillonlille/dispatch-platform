import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Artifact {
  format: 3;
  version: string;
  runtime: 'rust';
  schema: 3;
  files: { path: string; sha256: string; size: number }[];
  digest: string;
}
// The verifier is built from this checkout. Never execute the candidate binary.
function host<T>(...args: string[]): T {
  try {
    return JSON.parse(
      execFileSync('python3', ['tooling/runtime_artifact.py', 'artifact', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    ) as T;
  } catch (error) {
    const failure = error as { stderr?: string | Buffer };
    throw new Error(failure.stderr?.toString().trim() || 'Artifact verification failed');
  }
}
export const inventory = (root: string): Artifact['files'] => host('inventory', path.resolve(root));
export const writeManifest = (root: string, version: string): Artifact =>
  host('write', path.resolve(root), version);
export const verifyArtifact = (root: string): Artifact => host('verify', path.resolve(root));
