// UI side of the reading sessions (spec 6.4). The Rust core owns the sessions (heartbeat every 30 s, 2 min idle,
// crash recovery, <1 min discard, >12 h split); this only tells it when reading starts, continues and stops.
// Reading counts while: the Leitor tab is visible AND the page is visible (desktop "segundo plano" = minimized or
// on another workspace, i.e. document.visibilityState === 'hidden') AND the message is about the book in front AND
// the panel's mini-review ("Revisar aqui", spec 10.1) is not open.

/** Subset of the core's `StopReason` the UI reports ('idle' comes from the core's own ticker). */
export type StopReason = 'tab' | 'doc' | 'background' | 'close' | 'review';

export interface SessionDeps {
  start(uid: string, page: number): void;
  heartbeat(uid: string, page: number): void;
  stop(uid: string, reason: StopReason): void;
  now?: () => number;
}

/** The core ends a session after 2 min without activity (spec 6.4); after that, reading again starts a new one. */
export const IDLE_MS = 120_000;

export class SessionWiring {
  private tabVisible = false;
  private pageVisible = true;
  private activeId: string | null = null;
  private page = 0;
  /** Book whose session the app started and hasn't stopped. */
  private running: string | null = null;
  private closed = false;
  private reviewing = false;
  private lastSignal = 0;

  constructor(private readonly deps: SessionDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get reading(): boolean {
    return !this.closed && !this.reviewing && this.tabVisible && this.pageVisible && this.activeId !== null;
  }

  private stopRunning(reason: StopReason) {
    if (this.running !== null) {
      const uid = this.running;
      this.running = null;
      this.deps.stop(uid, reason);
    }
  }

  private startIfReading() {
    if (this.reading && this.running === null && this.activeId !== null) {
      this.running = this.activeId;
      this.lastSignal = this.now();
      this.deps.start(this.activeId, this.page);
    }
  }

  /** The Leitor tab became visible or hidden. */
  setTabVisible(visible: boolean) {
    if (visible === this.tabVisible) return;
    this.tabVisible = visible;
    if (visible) this.startIfReading();
    else this.stopRunning('tab');
  }

  /** `document.visibilityState` changed. */
  setPageVisible(visible: boolean) {
    if (visible === this.pageVisible) return;
    this.pageVisible = visible;
    if (visible) this.startIfReading();
    else this.stopRunning('background');
  }

  /** The panel's mini-review opened (reading pauses, reason 'review') or closed (reading resumes if still reading). */
  setReviewing(on: boolean) {
    if (on === this.reviewing) return;
    this.reviewing = on;
    if (on) this.stopRunning('review');
    else this.startIfReading();
  }

  /** `pdfcraft:active` (id null: no book of the library in front). */
  active(id: string | null, page: number) {
    if (id === this.activeId) {
      this.page = page;
      if (this.running === null) this.startIfReading();
      return;
    }
    this.stopRunning('doc');
    this.activeId = id;
    this.page = page;
    this.startIfReading();
  }

  /** `pdfcraft:page` / `pdfcraft:activity` of `id`. */
  activity(id: string | null, page?: number) {
    if (id === null || id !== this.activeId) return;
    if (page !== undefined) this.page = page;
    if (!this.reading) return;
    if (this.running !== null && this.now() - this.lastSignal > IDLE_MS) {
      // The core already ended it for inactivity (the end is the last activity): this is a new session.
      this.running = null;
    }
    if (this.running === null) {
      this.startIfReading();
    } else {
      this.lastSignal = this.now();
      this.deps.heartbeat(id, this.page);
    }
  }

  /** The window is closing: end the session for good. */
  close() {
    this.stopRunning('close');
    this.closed = true;
  }

  /** The window close was cancelled. */
  reopen() {
    this.closed = false;
    this.startIfReading();
  }

  get runningId(): string | null {
    return this.running;
  }
}
