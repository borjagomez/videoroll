/** Injected into every page by src/record/cursor.ts. */
interface VdgCursor {
  position(): { x: number; y: number };
  place(x: number, y: number): void;
  move(x: number, y: number, ms: number): Promise<void>;
  ripple(): Promise<void>;
  halo(rect: { x: number; y: number; width: number; height: number } | null): void;
}

/** Injected into every page by src/record/titlecard.ts. */
interface VdgTitle {
  hide(): Promise<void>;
}

interface Window {
  __vdgCursor?: VdgCursor;
  __vdgCursorInstalled?: boolean;
  __vdgTitle?: VdgTitle;
}
