import type {
  Uniform,
  UniformAdjustment,
  UniformInventory,
  UniformUpdates,
} from '../../../shared/contracts/uniforms.js';

export const uniformTotal = (uniform: Uniform) =>
  uniform.variants.reduce((sum, v) => sum + v.quantity, 0);

/** A delayed mutation response can never move a quantity backwards. */
export function applyUniformAdjustments(
  inventory: UniformInventory,
  adjustments: UniformAdjustment[],
): UniformInventory {
  const latest = new Map<string, UniformAdjustment>();
  for (const change of adjustments) {
    if (change.revision > (latest.get(change.variantId)?.revision ?? -1))
      latest.set(change.variantId, change);
  }
  return {
    ...inventory,
    uniforms: inventory.uniforms.map((uniform) => {
      if (!uniform.variants.some((v) => (latest.get(v.id)?.revision ?? -1) > v.revision))
        return uniform;
      return {
        ...uniform,
        variants: uniform.variants.map((variant) => {
          const change = latest.get(variant.id);
          return change && change.revision > variant.revision
            ? { ...variant, quantity: change.quantity, revision: change.revision }
            : variant;
        }),
      };
    }),
  };
}

/** Snapshots replace the catalog but keep acknowledgements newer than that snapshot. */
export function applyUniformSnapshot(
  current: UniformInventory | undefined,
  next: UniformInventory,
): UniformInventory {
  if (!current) return next;
  if (next.revision < current.revision) return current;
  const newer = current.uniforms
    .flatMap((u) => u.variants)
    .filter((v) => v.revision > next.revision)
    .map((v) => ({ variantId: v.id, revision: v.revision, quantity: v.quantity }));
  return applyUniformAdjustments(next, newer);
}
export function applyUniformUpdates(
  current: UniformInventory | undefined,
  update: UniformUpdates,
): UniformInventory | undefined {
  if (update.inventory) return applyUniformSnapshot(current, update.inventory);
  if (!current) return current;
  return {
    ...applyUniformAdjustments(current, update.adjustments),
    revision: Math.max(current.revision, update.revision),
  };
}

export function groupUniforms(uniforms: Uniform[]): Map<string, Uniform[]> {
  const groups = new Map<string, Uniform[]>();
  for (const uniform of uniforms) {
    const group = groups.get(uniform.category);
    if (group) group.push(uniform);
    else groups.set(uniform.category, [uniform]);
  }
  return groups;
}
