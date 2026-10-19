/**
 * A controllable clock for simulations. `now()` advances `speed` times faster
 * than wall time while running, and tasks scheduled with `at()` fire in time
 * order as the clock passes them. Everything time-based in a simulation should
 * read this clock instead of Date.now() or setTimeout.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

interface Task {
  at: number;
  seq: number;
  run: () => void | Promise<void>;
  label?: string;
}

export class SimClock implements Clock {
  #simTime: number;
  #anchorWall: number;
  #speed: number;
  #paused = false;
  #seq = 0;
  #tasks: Task[] = [];
  #timer?: ReturnType<typeof setInterval>;
  #listeners = new Set<(now: number) => void | Promise<void>>();
  #ticking = false;

  constructor(start: number, speed = 1) {
    this.#simTime = start;
    this.#anchorWall = Date.now();
    this.#speed = speed;
  }

  now(): number {
    if (this.#paused) return this.#simTime;
    return Math.floor(this.#simTime + (Date.now() - this.#anchorWall) * this.#speed);
  }

  get speed(): number {
    return this.#speed;
  }

  get paused(): boolean {
    return this.#paused;
  }

  setSpeed(speed: number): void {
    this.#rebase();
    this.#speed = Math.max(0, speed);
  }

  pause(): void {
    this.#rebase();
    this.#paused = true;
  }

  resume(): void {
    this.#anchorWall = Date.now();
    this.#paused = false;
  }

  /** Jumps to a time. Tasks due before it run in order on the next tick. */
  set(time: number): void {
    this.#simTime = time;
    this.#anchorWall = Date.now();
  }

  /** Schedules work at a simulated time. Returns a cancel function. */
  at(time: number, run: () => void | Promise<void>, label?: string): () => void {
    const task: Task = { at: time, seq: this.#seq++, run, label };
    this.#tasks.push(task);
    this.#tasks.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return () => {
      this.#tasks = this.#tasks.filter((t) => t !== task);
    };
  }

  pending(): Array<{ at: number; label?: string }> {
    return this.#tasks.map((t) => ({ at: t.at, label: t.label }));
  }

  clearTasks(): void {
    this.#tasks = [];
  }

  onTick(listener: (now: number) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Runs due tasks then tick listeners. Call it yourself in tests, or use start(). */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.now();
      while (this.#tasks.length && this.#tasks[0].at <= now) {
        const task = this.#tasks.shift()!;
        await task.run();
      }
      for (const listener of this.#listeners) await listener(now);
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Advances simulated time by `ms` in steps, running tasks and listeners at
   * each step. Deterministic, for tests and fast-forwarding.
   */
  async advance(ms: number, stepMs = 60_000): Promise<void> {
    const wasPaused = this.#paused;
    this.pause();
    const end = this.#simTime + ms;
    while (this.#simTime < end) {
      const nextTask = this.#tasks[0]?.at;
      let next = Math.min(end, this.#simTime + stepMs);
      if (nextTask !== undefined && nextTask > this.#simTime && nextTask < next) next = nextTask;
      this.#simTime = next;
      await this.tick();
    }
    if (!wasPaused) this.resume();
  }

  start(intervalMs = 250): void {
    this.stop();
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #rebase(): void {
    this.#simTime = this.now();
    this.#anchorWall = Date.now();
  }
}
