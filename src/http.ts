import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type ServerOptions } from './server.js';

export interface HttpOptions extends ServerOptions {
  host?: string;
  port?: number;
  /** When set, every request must send `Authorization: Bearer <authToken>`. Required on a non-loopback host. */
  authToken?: string;
  /** Host header values to accept (DNS rebinding protection). Default: localhost, 127.0.0.1 and [::1] with the port. */
  allowedHosts?: string[];
  /** Origin header values to accept when a browser sends one. Default: none (requests with an Origin are refused). */
  allowedOrigins?: string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function deny(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Serves MCP over Streamable HTTP at /mcp, stateless: every request gets its own server and transport, so nothing is
 * kept between requests. The CastPDF API key comes from the options (the CASTPDF_API_KEY environment variable), so
 * anyone who can reach this port can use it: by default it listens on 127.0.0.1 only.
 */
export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;
  if (!isLoopback(host) && !opts.authToken) {
    throw new Error(`Refusing to listen on ${host} without CASTPDF_MCP_AUTH_TOKEN: anyone reaching the port could use your CastPDF API key.`);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const actualPort = (server.address() as { port: number } | null)?.port ?? port;
    const allowedHosts = opts.allowedHosts ?? [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) return deny(res, 403, 'Host not allowed');
    const origin = req.headers.origin;
    if (origin && !(opts.allowedOrigins ?? []).includes(origin)) return deny(res, 403, 'Origin not allowed');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname !== '/mcp') return deny(res, 404, 'Not found: the MCP endpoint is /mcp');

    if (opts.authToken) {
      const header = req.headers.authorization ?? '';
      const given = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!safeEqual(given, opts.authToken)) {
        res.setHeader('www-authenticate', 'Bearer');
        return deny(res, 401, 'Unauthorized');
      }
    }

    if (req.method !== 'POST') {
      // stateless: no server-initiated stream (GET) and no session to delete (DELETE)
      res.setHeader('allow', 'POST');
      return deny(res, 405, 'Method not allowed: this server is stateless, use POST');
    }

    const mcp = createServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) deny(res, 500, `Internal error: ${(err as Error)?.message ?? err}`);
    }
  };

  const server = createHttpServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
