#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpServer } from './http.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `castpdf-mcp ${VERSION}: the CastPDF MCP server

Usage:
  castpdf-mcp                 stdio (for Claude Desktop, Claude Code, Cursor, ...)
  castpdf-mcp --http          Streamable HTTP on http://127.0.0.1:3000/mcp

Options:
  --http                      serve over HTTP instead of stdio (or MCP_TRANSPORT=http)
  --port <n>                  HTTP port (or PORT), default 3000
  --host <h>                  HTTP host (or HOST), default 127.0.0.1
  --help, --version

Environment:
  CASTPDF_API_KEY             required: a CastPDF API key (cpdf_test_... or cpdf_live_...)
  CASTPDF_BASE_URL            optional: default https://api.castpdf.com
  CASTPDF_MCP_AUTH_TOKEN      HTTP only: require "Authorization: Bearer <token>" (required on a non-loopback host)
  CASTPDF_MCP_ALLOWED_HOSTS   HTTP only: comma-separated Host header values to accept (behind a proxy)
  CASTPDF_MCP_ALLOWED_ORIGINS HTTP only: comma-separated browser origins to accept
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const list = (value: string | undefined) => value?.split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const apiKey = process.env.CASTPDF_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write('castpdf-mcp: set the CASTPDF_API_KEY environment variable to a CastPDF API key (dashboard > API keys).\n');
    process.exit(1);
  }
  const baseUrl = process.env.CASTPDF_BASE_URL || undefined;
  const http = argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';

  if (http) {
    const port = Number(arg('--port') ?? process.env.PORT ?? 3000);
    const host = arg('--host') ?? process.env.HOST ?? '127.0.0.1';
    const allowedHosts = list(process.env.CASTPDF_MCP_ALLOWED_HOSTS);
    const allowedOrigins = list(process.env.CASTPDF_MCP_ALLOWED_ORIGINS);
    const authToken = process.env.CASTPDF_MCP_AUTH_TOKEN || undefined;
    const server = await startHttpServer({
      apiKey,
      host,
      port,
      ...(baseUrl ? { baseUrl } : {}),
      ...(authToken ? { authToken } : {}),
      ...(allowedHosts ? { allowedHosts } : {}),
      ...(allowedOrigins ? { allowedOrigins } : {}),
    });
    const address = server.address() as { port: number };
    process.stderr.write(`castpdf-mcp ${VERSION} listening on http://${host.includes(':') ? `[${host}]` : host}:${address.port}/mcp\n`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  // stdio: stdout carries the protocol, so logs go to stderr only
  const server = createServer({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`castpdf-mcp: ${(err as Error)?.message ?? err}\n`);
  process.exit(1);
});
