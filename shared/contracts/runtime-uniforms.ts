import { z } from 'zod';
import type {
  UniformInventory,
  UniformAdjustment,
  UniformUpdates,
  UniformHistory,
} from './uniforms.js';

const count = z.number().int().nonnegative();
const fit = z.enum(['men', 'women', 'unisex']);
const variant = z.object({
  id: z.string(),
  fit,
  size: z.string(),
  quantity: count,
  revision: count,
});
export const uniformInventorySchema = z.object({
  revision: count,
  uniforms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      revision: count,
      variants: z.array(variant),
    }),
  ),
}) satisfies z.ZodType<UniformInventory>;
export const uniformAdjustmentSchema = z.object({
  revision: count,
  variantId: z.string(),
  quantity: count,
}) satisfies z.ZodType<UniformAdjustment>;
export const uniformUpdatesSchema = z.object({
  revision: count,
  inventory: uniformInventorySchema.nullable(),
  adjustments: z.array(uniformAdjustmentSchema),
}) satisfies z.ZodType<UniformUpdates>;
export const uniformHistorySchema = z.object({
  events: z.array(
    z.object({
      revision: count,
      kind: z.enum(['initialized', 'created', 'updated', 'archived', 'adjusted']),
      uniformName: z.string(),
      fit: fit.nullable(),
      size: z.string().nullable(),
      delta: z.number().int().nullable(),
      quantity: count.nullable(),
      actorName: z.string(),
      at: z.string(),
    }),
  ),
  nextBefore: count.nullable(),
}) satisfies z.ZodType<UniformHistory>;
