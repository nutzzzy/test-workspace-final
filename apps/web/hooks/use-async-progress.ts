"use client";

import { useCallback, useRef, useState } from "react";

export type ProgressStage = {
  /** Percent to reach for this stage (0–100) */
  to: number;
  label: string;
};

type JobState = {
  active: boolean;
  percent: number;
  label: string;
  error: string | null;
  success: string | null;
};

const IDLE: JobState = {
  active: false,
  percent: 0,
  label: "",
  error: null,
  success: null,
};

/**
 * Runs an async job while advancing a staged percentage for UX feedback.
 * Backend may not stream progress — stages are timed until the promise settles.
 */
export function useAsyncProgress() {
  const [state, setState] = useState<JobState>(IDLE);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);

  const run = useCallback(
    async <T,>(
      stages: ProgressStage[],
      job: () => Promise<T>,
      options?: {
        successLabel?: string | ((result: T) => string);
      },
    ): Promise<T> => {
      clearTimers();
      setState({
        active: true,
        percent: 2,
        label: stages[0]?.label ?? "",
        error: null,
        success: null,
      });

      const totalMs = 2400;
      stages.forEach((stage, index) => {
        const delay = Math.round(((index + 1) / (stages.length + 1)) * totalMs);
        const id = setTimeout(() => {
          setState((prev) =>
            prev.active
              ? { ...prev, percent: stage.to, label: stage.label }
              : prev,
          );
        }, delay);
        timers.current.push(id);
      });

      try {
        const result = await job();
        clearTimers();
        const successLabel =
          typeof options?.successLabel === "function"
            ? options.successLabel(result)
            : (options?.successLabel ??
              stages[stages.length - 1]?.label ??
              "");
        setState({
          active: true,
          percent: 100,
          label: successLabel,
          error: null,
          success: null,
        });
        await new Promise((r) => setTimeout(r, 280));
        setState({
          active: false,
          percent: 100,
          label: "",
          error: null,
          success: successLabel || null,
        });
        return result;
      } catch (e) {
        clearTimers();
        const message = e instanceof Error ? e.message : "REQUEST_FAILED";
        setState({
          active: false,
          percent: 0,
          label: "",
          error: message,
          success: null,
        });
        throw e;
      }
    },
    [clearTimers],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, run, reset, busy: state.active };
}
