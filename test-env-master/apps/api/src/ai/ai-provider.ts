import type { z } from "zod";
import type { AppLocale } from "./localize-fa";

export type AiGenerateOptions<T> = {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  locale?: AppLocale;
};

export interface AIProvider {
  readonly name: string;
  generateStructured<T>(options: AiGenerateOptions<T>): Promise<T>;
}
