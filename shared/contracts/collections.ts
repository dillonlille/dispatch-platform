import type { Narrow } from './narrow.js';
import type { Connection as GeneratedConnection } from './generated/Connection';
export type Connection = Narrow<GeneratedConnection, { provider: 'paycom' | 'cortex' }>;
