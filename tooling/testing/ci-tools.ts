import fs from 'node:fs';
import path from 'node:path';

/**
 * The assessment fixture the tools job of this ref or of main built from identical Rust
 * inputs and CI restored into this checkout, or undefined when the debug example must be
 * built here. Only the workspace's own `.ci-tools` directory is trusted, and only on CI;
 * the same rule as `tooling/ci_tool.py` applies to the planner and host tools.
 */
export function assessmentFixture(
  env: Record<string, string | undefined>,
  root: string,
): string | undefined {
  const tools = env.DISPATCH_CI_TOOLS;
  if (env.CI !== 'true' || !tools || path.resolve(tools) !== path.resolve(root, '.ci-tools'))
    return undefined;
  const binary = path.join(root, '.ci-tools/fixture/assessment-fixture');
  let info: fs.Stats;
  try {
    info = fs.lstatSync(binary);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    return undefined;
  }
  return binary;
}
