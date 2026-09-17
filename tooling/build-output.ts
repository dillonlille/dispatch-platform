import fs from 'node:fs';
import { verifyArtifact } from './artifact.js';

export async function replaceBuild(out: string, build: (staging: string) => Promise<void>) {
  const staging = fs.mkdtempSync(`${out}-staging-`);
  const previous = `${staging}-previous`;
  try {
    await build(staging);
    const manifest = verifyArtifact(staging);
    if (fs.existsSync(out)) fs.renameSync(out, previous);
    try {
      fs.renameSync(staging, out);
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, out);
      throw error;
    }
    fs.rmSync(previous, { recursive: true, force: true });
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    // A failed restore leaves the previous artifact recoverable beside the output.
  }
}
