import { z } from 'zod';
const position = { x: z.number().min(0).max(1600), y: z.number().min(0).max(1100) };
export const browserSessionId = z.string().regex(/^run_[a-f0-9]{32}$/);
export const browserInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), ...position }).strict(),
  z
    .object({
      kind: z.literal('pointer'),
      phase: z.enum(['down', 'move', 'up']),
      ...position,
      pressed: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      ...position,
      deltaX: z.number().min(-2000).max(2000),
      deltaY: z.number().min(-2000).max(2000),
    })
    .strict(),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal('key'),
      key: z.enum([
        'Enter',
        'Tab',
        'Backspace',
        'Delete',
        'Escape',
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ]),
      shift: z.boolean().optional(),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInputSchema>;
export interface BrowserFrame {
  image: string;
  sessionId: string;
}
