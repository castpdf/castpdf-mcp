import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.castpdf.com';

export interface ApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per request, in milliseconds. Default 120000. */
  timeoutMs?: number;
  /** Retries after 429 rate_limited. Default 2. */
  maxRetries?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** An error answer from the CastPDF API. */
export class CastPdfApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly docsUrl?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CastPdfApiError';
  }
}

type Query = Record<string, string | number | undefined>;

/**
 * A minimal CastPDF API client: just what the MCP tools need. (The full client is @castpdf/sdk; this server keeps
 * its own few lines so it has no dependency that is not on npm yet.)
 */
export class CastPdfApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ApiOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, undefined, body);
  }

  private async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      accept: 'application/json',
      'user-agent': `castpdf-mcp/${VERSION}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        const timedOut = (cause as Error)?.name === 'TimeoutError';
        throw new CastPdfApiError(0, timedOut ? 'timeout' : 'connection_error', timedOut ? `CastPDF did not answer within ${this.timeoutMs / 1000} s` : `Could not reach CastPDF: ${(cause as Error)?.message ?? cause}`);
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (res.ok) return parsed as T;

      const err = (parsed as { error?: { code?: string; message?: string; docs_url?: string; details?: Record<string, unknown> } } | undefined)?.error;
      const code = err?.code ?? `http_${res.status}`;
      // a 429 rate_limited was never processed, so it is safe to send again, also for a POST
      if (res.status === 429 && code === 'rate_limited' && attempt < this.maxRetries) {
        const seconds = Number(res.headers.get('retry-after'));
        await this.sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt, 10_000));
        continue;
      }
      throw new CastPdfApiError(res.status, code, err?.message ?? `HTTP ${res.status}`, err?.docs_url, err?.details);
    }
  }
}
