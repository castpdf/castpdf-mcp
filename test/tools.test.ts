import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { connect, json, text } from './helpers.js';

const T = '0b6f0c2e-6d4e-4a43-9a43-3f0f6c1b7a10';
const D = '9f1c2b3a-1111-4222-8333-944455556666';
const pdf = { id: D, status: 'succeeded', url: 'https://api.castpdf.com/v1/files/x?sig=y', expires_at: '2026-10-12T00:00:00Z', pages: 1, bytes: 1234, test: true, filename: 'a.pdf' };

describe('tool list', () => {
  it('exposes the six tools with descriptions and schemas', async () => {
    const { client, close } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_e_invoice', 'create_pdf', 'get_document', 'get_template_fields', 'list_documents', 'list_templates']);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
    const create = tools.find((t) => t.name === 'create_pdf')!;
    expect((create.inputSchema.properties as Record<string, { default?: unknown }>).test!.default).toBe(true);
    expect(create.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'list_templates')!.annotations?.readOnlyHint).toBe(true);
    await close();
  });
});

describe('list_templates and get_template_fields', () => {
  it('lists templates with paging and the API key', async () => {
    const { client, calls, close } = await connect([json({ data: [{ id: T, name: 'Invoice', current_version: 2, thumbnail_url: 'u' }], has_more: false })]);
    const result = await client.callTool({ name: 'list_templates', arguments: { limit: 10 } });
    expect(JSON.parse(text(result))).toEqual({ templates: [{ id: T, name: 'Invoice', current_version: 2 }], has_more: false });
    expect(calls[0]!.url.toString()).toBe('https://api.castpdf.com/v1/templates?limit=10');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer cpdf_test_abc');
    expect(calls[0]!.headers.get('user-agent')).toBe(`castpdf-mcp/${VERSION}`);
    await close();
  });

  it('returns fields without the no-code tree', async () => {
    const { client, calls, close } = await connect([json({ template_id: T, version: 2, fields: [{ key: 'customer.name', type: 'string', sample: 'Ada' }], line_items: [], tree: [{}], tree_truncated: false })]);
    const result = await client.callTool({ name: 'get_template_fields', arguments: { template_id: T, version: 2 } });
    const body = JSON.parse(text(result));
    expect(body.fields[0].key).toBe('customer.name');
    expect(body.tree).toBeUndefined();
    expect(calls[0]!.url.pathname).toBe(`/v1/templates/${T}/fields`);
    expect(calls[0]!.url.searchParams.get('version')).toBe('2');
    await close();
  });

  it('rejects a template id that is not a UUID without calling the API', async () => {
    const { client, calls, close } = await connect([]);
    const result = await client.callTool({ name: 'get_template_fields', arguments: { template_id: '../me' } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await close();
  });
});

describe('create_pdf', () => {
  it('renders a template in test mode by default and returns the download url', async () => {
    const { client, calls, close } = await connect([json(pdf)]);
    const result = await client.callTool({ name: 'create_pdf', arguments: { template_id: T, data: { customer: { name: 'Ada' } } } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ template_id: T, data: { customer: { name: 'Ada' } }, test: true, response: 'url' });
    expect(text(result)).toContain(pdf.url);
    expect(text(result)).toContain('TEST document');
    await close();
  });

  it('makes a live document only when test is false', async () => {
    const { client, calls, close } = await connect([json({ ...pdf, test: false })]);
    const result = await client.callTool({ name: 'create_pdf', arguments: { html: '<h1>Hi</h1>', css: 'h1{color:red}', format: 'Letter', margins: '10mm 20mm', test: false } });
    expect(calls[0]!.body).toEqual({ html: '<h1>Hi</h1>', css: 'h1{color:red}', format: 'Letter', margins: '10mm 20mm', test: false, response: 'url' });
    expect(text(result)).not.toContain('TEST document');
    await close();
  });

  it.each([
    [{}, 'exactly one of template_id or html'],
    [{ template_id: T, html: '<p>x</p>' }, 'exactly one of template_id or html'],
    [{ template_id: T, css: 'p{}' }, "css can't be combined"],
    [{ html: '<p>x</p>', template_version: 2 }, 'template_version needs template_id'],
  ])('validates %j', async (args, message) => {
    const { client, calls, close } = await connect([]);
    const result = await client.callTool({ name: 'create_pdf', arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(calls).toHaveLength(0);
    await close();
  });

  it('rejects bad margins through the schema', async () => {
    const { client, calls, close } = await connect([]);
    const result = await client.callTool({ name: 'create_pdf', arguments: { html: 'x', margins: 'wide' } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await close();
  });

  it('turns API errors into a readable tool error', async () => {
    const { client, close } = await connect([json({ error: { code: 'template_not_found', message: 'Template not found', docs_url: 'https://castpdf.com/docs/errors' } }, 404)]);
    const result = await client.callTool({ name: 'create_pdf', arguments: { template_id: T } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('404 template_not_found: Template not found');
    expect(text(result)).toContain('list_templates');
    await close();
  });

  it('retries a 429 rate_limited', async () => {
    const { client, calls, close } = await connect([json({ error: { code: 'rate_limited', message: 'slow' } }, 429, { 'retry-after': '1' }), json(pdf)]);
    const result = await client.callTool({ name: 'create_pdf', arguments: { html: 'x' } });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    await close();
  });

  it('reports a missing key clearly', async () => {
    const { client, close } = await connect([json({ error: { code: 'invalid_api_key', message: 'Missing or invalid API key' } }, 401)]);
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    expect(text(result)).toContain('CASTPDF_API_KEY');
    await close();
  });
});

describe('create_e_invoice', () => {
  const invoice = {
    number: 'RE-1',
    issue_date: '2026-10-10',
    currency: 'EUR',
    seller: { name: 'Muster GmbH', vat_id: 'DE123456789', address: { city: 'Berlin', country_code: 'DE' } },
    buyer: { name: 'Kunde AG', address: { country_code: 'DE' } },
    payment: { iban: 'DE02120300000000202051', terms: 'Net 14 days' },
    lines: [{ name: 'Consulting', quantity: 8, unit_code: 'HUR', unit_price: '95.00', vat: { category: 'S', rate: 19 } }],
    billing_period: { start: '2026-09-01', end: '2026-09-30' },
  };

  it('sends e_invoice in test mode and passes unknown invoice fields through', async () => {
    const { client, calls, close } = await connect([json({ ...pdf, e_invoice: { standard: 'zugferd', profile: 'en16931', xml_filename: 'factur-x.xml' } })]);
    const result = await client.callTool({ name: 'create_e_invoice', arguments: { standard: 'zugferd', invoice } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.body).toEqual({ test: true, response: 'url', e_invoice: { standard: 'zugferd', invoice } });
    expect(text(result)).toContain('zugferd');
    await close();
  });

  it('validates the invoice shape', async () => {
    const { client, calls, close } = await connect([]);
    const result = await client.callTool({ name: 'create_e_invoice', arguments: { standard: 'zugferd', invoice: { ...invoice, issue_date: '10.10.2026', lines: [] } } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await close();
  });
});

describe('documents', () => {
  it('lists and gets documents', async () => {
    const { client, calls, close } = await connect([
      json({ data: [{ ...pdf, template_id: T, created_at: '2026-10-10T00:00:00Z' }], next_before: 'c1' }),
      json({ ...pdf, status: 'failed', error_code: 'render_failed', url: null }),
    ]);
    const list = JSON.parse(text(await client.callTool({ name: 'list_documents', arguments: { limit: 5, before: 'c0' } })));
    expect(list.next_before).toBe('c1');
    expect(list.documents[0]).toMatchObject({ id: D, download_url: pdf.url, template_id: T });
    expect(calls[0]!.url.search).toBe('?limit=5&before=c0');
    const doc = JSON.parse(text(await client.callTool({ name: 'get_document', arguments: { id: D } })));
    expect(doc).toMatchObject({ status: 'failed', error_code: 'render_failed', download_url: null });
    expect(calls[1]!.url.pathname).toBe(`/v1/pdf/${D}`);
    await close();
  });
});

describe('metadata', () => {
  it('keeps package.json, server.json and VERSION in sync', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(VERSION);
    expect(server.version).toBe(VERSION);
    expect(server.packages[0].version).toBe(VERSION);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
