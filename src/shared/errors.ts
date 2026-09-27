export class StudioError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = "StudioError";
    this.code = code;
    this.hint = hint;
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
