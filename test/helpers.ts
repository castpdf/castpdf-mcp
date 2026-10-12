import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that answers from `replies` in order and records every call. */
export function mockFetch(replies: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

/** An MCP client connected in memory to a CastPDF server whose API calls go to `replies`. */
export async function connect(replies: Array<Response | Error>) {
  const { fetch, calls } = mockFetch(replies);
  const server = createServer({ apiKey: 'cpdf_test_abc', fetch, sleep: async () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, calls, close: () => client.close() };
}

export function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('\n');
}
