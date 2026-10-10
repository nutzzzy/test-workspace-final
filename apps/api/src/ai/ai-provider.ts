import type { z } from "zod";
import type { AppLocale } from "./localize-fa";

export type AiGenerateOptions<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  locale?: AppLocale;
  /** Aborts the request in flight (the user cancelled the analysis). */
  signal?: AbortSignal;
  /** Called as the model writes (streaming providers), with the number of new tokens. */
  onTokens?: (count: number) => void;
  /**
   * Called when the answer is partial: stopped at the writing time limit
   * ("time"), or cut by the service's answer length limit ("length").
   */
  onCut?: (reason: "time" | "length") => void;
  /** Epoch ms by which the answer must be in; what was written by then is used. */
  deadlineAt?: number;
};

export interface AIProvider {
  readonly name: string;
  generateStructured<T>(options: AiGenerateOptions<T>): Promise<T>;
}

/** Thrown when the analysis time limit is reached before a call could start. */
export const TIME_LIMIT = "The analysis reached its time limit";
