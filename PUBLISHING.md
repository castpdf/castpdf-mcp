# Publishing @castpdf/mcp

For the CastPDF team. Users read README.md.

The package is `@castpdf/mcp` (npm user `castpdf` owns the `@castpdf` scope). Its MCP registry name is
`io.github.castpdf/castpdf-mcp` (`mcpName` in package.json and `name` in server.json; the registry checks that they
match). This folder is a plain npm project with its own lockfile and is not part of the pnpm workspace: use `npm` in
here.

Nothing on castpdf.com mentions this server yet. Do not add it to the site or the docs until a version is public and
listed; do that in a separate, reviewed change afterwards.

## Develop and check

```powershell
cd integrations\mcp
npm ci
npm run typecheck
npm test          # vitest: tools over an in-memory MCP connection, HTTP on a random local port; the API is mocked
npm run build     # dist/cli.js (the castpdf-mcp command) and dist/index.js
```

Try it by hand with the MCP Inspector (stop it with Ctrl+C when done):

```powershell
$env:CASTPDF_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString 'CastPDF test key')))
npx @modelcontextprotocol/inspector node dist/cli.js
```

The server talks to the API with its own small client (`src/api.ts`) so that it does not depend on `@castpdf/sdk`
before that is on npm. Switching to the SDK later is optional.

## One-time setup (owner)

1. **A public GitHub repository** `castpdf/castpdf-mcp` (the `repository` URL in package.json and server.json) under
   the GitHub account `castpdf`.
2. **Put this folder at the root of that repository** (copy it, or `git subtree split --prefix integrations/mcp`).
   GitHub only runs workflows from the top-level `.github` folder.
3. **Let the workflow stage on npm**, as for the SDK: first release with a granular npm token stored as the repository
   secret `NPM_TOKEN`; afterwards a trusted publisher on npmjs.com (owner `castpdf`, repository `castpdf-mcp`,
   workflow `publish.yml`, allowed to stage publish) and delete the secret.
4. **The MCP registry publisher CLI**, `mcp-publisher` (https://github.com/modelcontextprotocol/registry, releases or
   `brew install mcp-publisher`). The `io.github.castpdf/` namespace is proven by logging in with the GitHub account
   `castpdf`. (A `com.castpdf/...` name would need a DNS TXT record on castpdf.com instead; not needed.)

## Release

1. **Bump the version** in `package.json`, `src/version.ts` and both `version` fields of `server.json` (a test fails
   when they differ), update `CHANGELOG.md` and "Version history" in README.md, run `npm install`.
2. **Check:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. All must pass.
3. **Commit** in the monorepo, copy the folder to the public repository, commit there and push a tag with the bare
   version, for example `0.1.0`.
4. **Stage:** the tag starts `.github/workflows/publish.yml` (`npm stage publish --provenance --access public`).
5. **Approve (owner, with 2FA)** on npmjs.com (or `npm stage approve <stage-id>`). Check the provenance badge, and that
   `npx -y @castpdf/mcp --version` prints the new version.

## Submit to the MCP registry (after the npm version is public)

The registry only lists servers whose package is already on npm, and checks that the npm package's `mcpName` equals
the server.json `name`. From this folder, in a terminal of the owner:

```powershell
mcp-publisher validate     # checks server.json against the schema (update "$schema" if it reports a newer one)
mcp-publisher login github # browser login as the GitHub account castpdf
mcp-publisher publish
```

Then check https://registry.modelcontextprotocol.io/v0/servers?search=castpdf. Repeat `mcp-publisher publish` for each
new version (after it is public on npm). Submitting is a manual owner step; nothing in this repository does it.

## Before the first release, test by hand

With a test key: add the server to Claude Desktop, Claude Code and Cursor using the README snippets, ask for the
templates, a test PDF from a template, a PDF from HTML, a ZUGFeRD and an XRechnung e-invoice, and a document lookup.
Check that the agent keeps `test` true unless asked for a live document. Then run `--http` locally with
`CASTPDF_MCP_AUTH_TOKEN` set and connect with the Inspector.
