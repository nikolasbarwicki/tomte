import { EngineError } from "./engine-cli.ts";

export const LANE_BUSY_MESSAGE = "previous browser call still running";

/** Runs one job at a time, in arrival order. A job that cannot start within `waitMs` is refused. */
export class Lane {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  /** True while a job runs or waits. */
  get busy(): boolean {
    return this.pending > 0;
  }

  async run<T>(job: () => Promise<T>, waitMs: number): Promise<T> {
    const previous = this.tail;
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();
    this.tail = done;
    this.pending++;
    const turn = Promise.withResolvers<void>();
    const timer = setTimeout(() => turn.reject(new EngineError(LANE_BUSY_MESSAGE)), waitMs);
    void previous.then(() => turn.resolve());
    try {
      await turn.promise;
    } catch (e) {
      // The slot stays in the queue until the job ahead finishes, so later jobs keep their order.
      void previous.then(() => {
        this.pending--;
        finish();
      });
      throw e;
    } finally {
      clearTimeout(timer);
    }
    try {
      return await job();
    } finally {
      this.pending--;
      finish();
    }
  }
}
