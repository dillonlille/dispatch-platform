export type BrowserInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'pointer'; phase: 'down' | 'move' | 'up'; x: number; y: number; pressed: boolean }
  | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'type'; text: string }
  | {
      kind: 'key';
      key:
        | 'Enter'
        | 'Tab'
        | 'Backspace'
        | 'Delete'
        | 'Escape'
        | 'ArrowDown'
        | 'ArrowUp'
        | 'ArrowLeft'
        | 'ArrowRight'
        | 'Home'
        | 'End'
        | 'PageUp'
        | 'PageDown';
      shift?: boolean;
    };
export interface BrowserFrame {
  image: string;
  sessionId: string;
}
