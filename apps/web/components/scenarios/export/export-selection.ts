/** What the export dialog reads from GET /scenarios/:id/export, and how its choices depend on each other. */

export type ExportOptions = {
  frameworks: Array<{ id: string; label: string; languages: Array<{ id: string; label: string; filename: string }> }>;
  providers: Array<{ id: string; name: string; model: string; usable: boolean; blockedReason: string | null }>;
  defaultProviderId: string | null;
};

/** `providerId` "" = the workspace default (the AI routing of the automation stage). */
export type ExportSelection = { framework: string; language: string; providerId: string };

export type ExportResult = {
  framework: string;
  language: string;
  code: string;
  filename: string;
  warnings: string[];
  provider: { id: string; name: string; model: string };
};

export function initialSelection(options: ExportOptions): ExportSelection {
  const framework = options.frameworks[0];
  return { framework: framework?.id ?? "", language: framework?.languages[0]?.id ?? "", providerId: "" };
}

/** Languages follow the framework: the current one is kept when the new framework supports it. */
export function withFramework(options: ExportOptions, selection: ExportSelection, frameworkId: string): ExportSelection {
  const framework = options.frameworks.find((item) => item.id === frameworkId);
  if (!framework) return selection;
  const keep = framework.languages.some((item) => item.id === selection.language);
  return { ...selection, framework: framework.id, language: keep ? selection.language : (framework.languages[0]?.id ?? "") };
}

export function languagesOf(options: ExportOptions, frameworkId: string) {
  return options.frameworks.find((item) => item.id === frameworkId)?.languages ?? [];
}

export function filenameOf(options: ExportOptions, selection: ExportSelection): string {
  return languagesOf(options, selection.framework).find((item) => item.id === selection.language)?.filename ?? "";
}

/** The connection "Workspace default" stands for, if any can be used. */
export function defaultProvider(options: ExportOptions) {
  return options.providers.find((item) => item.id === options.defaultProviderId && item.usable) ?? null;
}

/** Generate is possible: a framework, a language, and a usable AI connection for the choice. */
export function canGenerate(options: ExportOptions, selection: ExportSelection): boolean {
  if (!filenameOf(options, selection)) return false;
  if (selection.providerId) return options.providers.some((item) => item.id === selection.providerId && item.usable);
  return options.providers.some((item) => item.usable);
}

/** A result belongs to the choice it was made for; another choice needs a new generation. */
export function resultMatches(result: ExportResult | null, selection: ExportSelection, generatedWith: ExportSelection | null): boolean {
  return Boolean(
    result &&
      generatedWith &&
      generatedWith.framework === selection.framework &&
      generatedWith.language === selection.language &&
      generatedWith.providerId === selection.providerId,
  );
}
