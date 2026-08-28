export interface ElectronBeforeQuitEvent {
  preventDefault(): void;
}

type ExitApplication = (code: number) => void;

/**
 * Defers Electron's cancellable native quit until owned resources are
 * contained, then completes it with the non-cancellable exit primitive.
 */
export class DeferredElectronQuit {
  private requestStarted = false;
  private completionScheduled = false;

  constructor(private readonly exitApplication: ExitApplication) {}

  defer(event: ElectronBeforeQuitEvent): boolean {
    if (this.completionScheduled) return false;
    event.preventDefault();
    if (this.requestStarted) return false;
    this.requestStarted = true;
    return true;
  }

  complete(code: number): boolean {
    if (this.completionScheduled) return false;
    this.completionScheduled = true;
    this.exitApplication(code);
    return true;
  }
}
