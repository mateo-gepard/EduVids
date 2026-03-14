/**
 * Async semaphore for bounded concurrency control.
 * Callers `await acquire()`, then call `release()` when done.
 */
export class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}
