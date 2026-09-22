export type { Uniform } from './generated/Uniform';
export type { UniformVariant } from './generated/UniformVariant';
export type { UniformFit } from './generated/UniformFit';
export type { UniformInventory } from './generated/UniformInventory';
export type { UniformAdjustment } from './generated/UniformAdjustment';
export type { UniformUpdates } from './generated/UniformUpdates';
export type { UniformHistory } from './generated/UniformHistory';
export type { UniformEvent } from './generated/UniformEvent';
import type { UniformFit } from './generated/UniformFit';

export interface UniformInput {
  name: string;
  category: string;
  revision?: number;
  variants: { id?: string; fit: UniformFit; size: string }[];
}

export const uniformFits = ['men', 'women', 'unisex'] as const;
export const uniformFitLabels: Record<UniformFit, string> = {
  men: 'Men’s',
  women: 'Women’s',
  unisex: 'Unisex',
};
export const uniformSizePresets = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
export const uniformCategoryPresets = ['Tops', 'Bottoms', 'Vests', 'Jackets', 'Hats'];
