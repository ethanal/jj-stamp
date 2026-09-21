export interface ErrorDetail {
  label: string;
  code?: string;
  output?: string;
}

/** Keep the server's diagnostic output separate from its human-readable summary. */
export class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly output?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function errorDetails(error: unknown, label = "Request"): ErrorDetail[] {
  return error instanceof RequestError && (error.code || error.output)
    ? [{ label, code: error.code, output: error.output }]
    : [];
}

export async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/${route}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fold-Request": "1",
          },
          body: JSON.stringify(body),
        },
  );
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError(
      response.ok
        ? `Invalid JSON response from ${route}.`
        : `Request failed (HTTP ${response.status}).`,
      response.status,
      undefined,
      text || undefined,
    );
  }
  if (!response.ok) {
    const payload =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    throw new RequestError(
      typeof payload.error === "string" && payload.error
        ? payload.error
        : `Request failed (HTTP ${response.status}).`,
      response.status,
      typeof payload.code === "string" ? payload.code : undefined,
      typeof payload.output === "string" ? payload.output : undefined,
    );
  }
  return value as T;
}
