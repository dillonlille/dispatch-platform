import type { Narrow } from './narrow.js';
import type { ConnectionFeature } from './features.js';
import type { Connection as GeneratedConnection } from './generated/Connection';
export type Connection = Narrow<GeneratedConnection, { provider: ConnectionFeature }>;

export type { CollectionUpdates } from './generated/CollectionUpdates';
export type { CollectionChange } from './generated/CollectionChange';
