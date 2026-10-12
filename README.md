# CastPDF MCP server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [CastPDF](https://castpdf.com). It
lets AI agents (Claude, Cursor and other MCP clients) list your PDF templates, create PDFs and EU e-invoices, and look
up documents, using your CastPDF API key.

Documents are **test documents by default** (watermarked, not counted against your plan). The agent only makes a live
document when you explicitly ask for one, and a `cpdf_test_...` key can never make live documents at all. Start with a
test key.

## Tools

| Tool | What it does |
| --- | --- |
| `list_templates` | Lists your saved templates (id, name, version). |
| `get_template_fields` | The data a template expects, read from its sample data (fields and line items). |
| `create_pdf` | Renders a template with `data`, or raw `html`, and returns a signed download URL. `test` defaults to true. |
| `create_e_invoice` | Issues a ZUGFeRD / Factur-X PDF or an XRechnung XML from a structured invoice and returns a download URL. `test` defaults to true. |
| `list_documents` | Recent documents, newest first, with status and download URLs. |
| `get_document` | One document by id: status, error code, fresh download URL. |

Download links are signed and expire (see `expires_at`); the agent shares the link, the file itself is not sent
through the conversation.

## Setup

You need Node.js 20 or newer and a CastPDF API key (dashboard > API keys). The server reads the key from the
`CASTPDF_API_KEY` environment variable.

### Claude Desktop

Settings > Developer > Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "castpdf": {
      "command": "npx",
      "args": ["-y", "@castpdf/mcp"],
      "env": { "CASTPDF_API_KEY": "cpdf_test_..." }
    }
  }
}
```

Restart Claude Desktop. On Windows, if `npx` is not found, use `"command": "cmd"` and
`"args": ["/c", "npx", "-y", "@castpdf/mcp"]`.

### Claude Code

```sh
claude mcp add castpdf --env CASTPDF_API_KEY=cpdf_test_... -- npx -y @castpdf/mcp
```

Add `--scope user` to use it in every project. Check it with `claude mcp list` or `/mcp` inside Claude Code.

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "castpdf": {
      "command": "npx",
      "args": ["-y", "@castpdf/mcp"],
      "env": { "CASTPDF_API_KEY": "cpdf_test_..." }
    }
  }
}
```

Do not commit a file that contains your key.

### Other clients

Any MCP client that starts stdio servers works with the command `npx -y @castpdf/mcp` and the environment variable
`CASTPDF_API_KEY`.

## Streamable HTTP

For clients that connect over HTTP, or to run one shared server:

```sh
CASTPDF_API_KEY=cpdf_test_... npx -y @castpdf/mcp --http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp   health check: http://127.0.0.1:3000/health
```

Every request to that endpoint uses the server's API key, so:

- By default it listens on `127.0.0.1` only and accepts only `localhost`, `127.0.0.1` and `[::1]` as Host header
  (DNS rebinding protection) and no browser Origin.
- Set `CASTPDF_MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on every request. It is required to listen
  on any other interface (`--host 0.0.0.0`). Put a TLS-terminating proxy in front of it, and list the public host name
  in `CASTPDF_MCP_ALLOWED_HOSTS`.
- The server is stateless (no sessions, POST only), so it can run behind a load balancer.

Example client config for HTTP (Claude Code):

```sh
claude mcp add --transport http castpdf http://127.0.0.1:3000/mcp
```

## Configuration

| Variable / flag | Default | Meaning |
| --- | --- | --- |
| `CASTPDF_API_KEY` | (required) | Your CastPDF API key. |
| `CASTPDF_BASE_URL` | `https://api.castpdf.com` | API base URL. |
| `--http` or `MCP_TRANSPORT=http` | stdio | Serve Streamable HTTP instead of stdio. |
| `--port` or `PORT` | `3000` | HTTP port. |
| `--host` or `HOST` | `127.0.0.1` | HTTP interface. |
| `CASTPDF_MCP_AUTH_TOKEN` | none | Bearer token required on HTTP requests. |
| `CASTPDF_MCP_ALLOWED_HOSTS` | localhost names | Comma-separated Host header values to accept. |
| `CASTPDF_MCP_ALLOWED_ORIGINS` | none | Comma-separated browser origins to accept. |

## Example prompts

- "Which CastPDF templates do I have?"
- "Make a test PDF of the Invoice template for Ada Lovelace, 3 hours of consulting at 120 EUR."
- "Create a ZUGFeRD invoice from Muster GmbH (DE123456789, Berlin) to Kunde AG, Hamburg: 8 hours consulting at 95 EUR,
  19 % VAT, payable within 14 days to IBAN DE02 1203 0000 0000 2020 51."
- "Did my last document fail? Why?"

## Use as a library

```ts
import { createServer } from '@castpdf/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createServer({ apiKey: process.env.CASTPDF_API_KEY! });
await server.connect(new StdioServerTransport());
```

## Version history

- 0.1.0: first release.

## License

MIT
