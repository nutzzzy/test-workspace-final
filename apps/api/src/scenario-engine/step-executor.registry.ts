import type { StepExecutor } from "./types";

export class StepExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();

  register(executor: StepExecutor) {
    this.executors.set(executor.type, executor);
  }

  resolve(type: string): StepExecutor {
    const executor = this.executors.get(type);
    if (!executor) {
      throw new Error(`Unknown StepType: ${type}`);
    }
    return executor;
  }

  list(): string[] {
    return [...this.executors.keys()];
  }
}
