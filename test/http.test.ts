import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { json, mockFetch } from './helpers.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const base = () => `http://127.0.0.1:${(server!.address() as { port: number }).port}`;

describe('streamable HTTP', () => {
  it('serves the tools at /mcp', async () => {
    const { fetch, calls } = mockFetch([json({ data: [{ id: 't1', name: 'Invoice' }], has_more: false })]);
    server = await startHttpServer({ apiKey: 'cpdf_test_abc', port: 0, fetch });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const result = await client.callTool({ name: 'list_templates', arguments: {} });
    expect(JSON.stringify(result)).toContain('Invoice');
    expect(calls).toHaveLength(1);
    await client.close();
  });

  it('requires the auth token when one is set', async () => {
    server = await startHttpServer({ apiKey: 'k', port: 0, authToken: 'secret-token' });
    const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
    expect((await fetch(`${base()}/mcp`, init)).status).toBe(401);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { authorization: 'Bearer secret-token' } } }));
    expect((await client.listTools()).tools).toHaveLength(6);
    await client.close();
  });

  it('refuses foreign Host and Origin headers, other paths and GET', async () => {
    server = await startHttpServer({ apiKey: 'k', port: 0 });
    expect((await fetch(`${base()}/health`)).status).toBe(200);
    expect((await fetch(`${base()}/other`)).status).toBe(404);
    expect((await fetch(`${base()}/mcp`)).status).toBe(405);
    expect((await fetch(`${base()}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    // Host is a forbidden header in fetch, so send a raw request
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base()}/health`, { headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode!));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('refuses to listen on a public interface without a token', async () => {
    expect(() => startHttpServer({ apiKey: 'k', host: '0.0.0.0', port: 0 })).toThrow(/CASTPDF_MCP_AUTH_TOKEN/);
  });
});
