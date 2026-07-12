export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';

export interface MouseEvent {
  code: number;
  x: number;
  y: number;
  down: boolean;
}

export function mouseEvent(data: string): MouseEvent | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(data);
  if (!match) return null;
  return { code: Number(match[1]), x: Number(match[2]), y: Number(match[3]), down: match[4] === 'M' };
}

export function mouseWheel(data: string): number {
  const event = mouseEvent(data);
  if (!event?.down || (event.code & 64) !== 64) return 0;
  return (event.code & 1) === 0 ? 3 : -3;
}

export function mouseClick(data: string): { x: number; y: number } | null {
  const event = mouseEvent(data);
  if (!event?.down || event.code !== 0) return null;
  return { x: event.x, y: event.y };
}
