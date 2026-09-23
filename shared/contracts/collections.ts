import type { Narrow } from './narrow.js';
import type { Connection as GeneratedConnection } from './generated/Connection';
export type Connection = Narrow<GeneratedConnection, { provider: 'paycom' | 'cortex' }>;

export type { CollectionUpdates } from './generated/CollectionUpdates';
export type { CollectionChange } from './generated/CollectionChange';
