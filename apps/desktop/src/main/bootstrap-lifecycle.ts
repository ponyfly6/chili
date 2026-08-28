export class BootstrapLifecycleGuard {
  private shutdownStarted = false;

  get quitStarted(): boolean {
    return this.shutdownStarted;
  }

  beginShutdown(): boolean {
    if (this.shutdownStarted) return false;
    this.shutdownStarted = true;
    return true;
  }

  canContinue(): boolean {
    return !this.shutdownStarted;
  }
}
