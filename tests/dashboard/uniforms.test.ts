import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyUniformAdjustments,
  applyUniformSnapshot,
  applyUniformUpdates,
} from '../../dashboard/src/lib/uniforms.js';
import type { UniformInventory } from '../../shared/contracts/uniforms.js';

const inventory = (): UniformInventory => ({
  revision: 1,
  uniforms: [
    {
      id: 'shirt',
      name: 'Polo',
      category: 'Tops',
      revision: 1,
      variants: [
        { id: 'men-m', fit: 'men', size: 'M', quantity: 0, revision: 1 },
        { id: 'women-s', fit: 'women', size: 'S', quantity: 0, revision: 1 },
      ],
    },
  ],
});

test('late acknowledgements never replace a newer stock count or skip another user’s change', () => {
  let data = applyUniformAdjustments(inventory(), [
    { variantId: 'men-m', quantity: 2, revision: 4 },
  ]);
  assert.equal(data.revision, 1); // the stream still needs to deliver revisions 2 and 3.
  data = applyUniformUpdates(data, {
    revision: 4,
    inventory: null,
    adjustments: [
      { variantId: 'men-m', quantity: 1, revision: 2 },
      { variantId: 'women-s', quantity: 1, revision: 3 },
      { variantId: 'men-m', quantity: 2, revision: 4 },
    ],
  })!;
  data = applyUniformAdjustments(data, [{ variantId: 'men-m', quantity: 1, revision: 2 }]);
  assert.equal(data.revision, 4);
  assert.deepEqual(
    data.uniforms[0]!.variants.map((v) => v.quantity),
    [2, 1],
  );
});

test('catalog snapshots keep newer acknowledgements and archived variants cannot reappear', () => {
  const current = applyUniformAdjustments(inventory(), [
    { variantId: 'men-m', quantity: 2, revision: 4 },
  ]);
  const snapshot = inventory();
  snapshot.revision = 3;
  snapshot.uniforms[0]!.name = 'Renamed polo';
  const merged = applyUniformSnapshot(current, snapshot);
  assert.equal(merged.uniforms[0]!.name, 'Renamed polo');
  assert.equal(merged.uniforms[0]!.variants[0]!.quantity, 2);
  assert.equal(applyUniformSnapshot(merged, inventory()), merged);
  const archived = applyUniformSnapshot(merged, { revision: 5, uniforms: [] });
  assert.deepEqual(
    applyUniformAdjustments(archived, [{ variantId: 'men-m', quantity: 1, revision: 2 }]).uniforms,
    [],
  );
});
