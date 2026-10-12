import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CastPdfApi, CastPdfApiError, type ApiOptions } from './api.js';
import { VERSION } from './version.js';

const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'must be a UUID');
const LENGTH = '(?:0|\\d+(?:\\.\\d+)?(?:mm|cm|in|px|pt))';
const decimal = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal such as "19.99"')]);

const testFlag = z
  .boolean()
  .default(true)
  .describe(
    'true (default): a watermarked test document that is not counted against the plan. Set false ONLY when the user explicitly asks for a live, final, unwatermarked document. A test API key always makes test documents.',
  );

const pageOptions = {
  format: z
    .union([z.enum(['A4', 'A5', 'Letter', 'Legal']), z.object({ width: z.string().regex(new RegExp(`^${LENGTH}$`)), height: z.string().regex(new RegExp(`^${LENGTH}$`)) })])
    .optional()
    .describe('Page size: A4, A5, Letter, Legal, or { width, height } such as "210mm". Default: the template setting, else A4.'),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  margins: z
    .string()
    .regex(new RegExp(`^${LENGTH}(?: ${LENGTH}){0,3}$`), 'like CSS margins, e.g. "20mm" or "10mm 15mm"')
    .optional()
    .describe('CSS-style margins with units, e.g. "20mm" or "10mm 15mm 10mm 15mm".'),
  mode: z.enum(['fast', 'print']).optional().describe('fast (default) or print (paged media: page numbers, running headers).'),
};

const filename = z.string().max(100).optional().describe('File name of the PDF, e.g. "invoice-1042.pdf".');

const address = z
  .object({
    line1: z.string().optional().describe('Street and number.'),
    line2: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    subdivision: z.string().optional(),
    country_code: z.string().regex(/^[A-Z0-9]{2}$/, 'ISO 3166-1 alpha-2, e.g. DE').describe('ISO 3166-1 alpha-2, e.g. DE.'),
  })
  .passthrough();

const party = z
  .object({
    name: z.string().min(1).describe('Legal name.'),
    address,
    vat_id: z.string().optional().describe('VAT id with country prefix, e.g. DE123456789.'),
    tax_number: z.string().optional().describe('National tax number (Steuernummer), seller only.'),
    electronic_address: z.object({ value: z.string(), scheme: z.string().optional() }).optional().describe('E-mail (scheme EM, default) or another CEF EAS address. XRechnung needs it for seller and buyer.'),
    contact: z.object({ name: z.string().optional(), phone: z.string().optional(), email: z.string().optional() }).optional(),
  })
  .passthrough();

const invoice = z
  .object({
    number: z.string().min(1).describe('Invoice number.'),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('YYYY-MM-DD.'),
    currency: z.string().length(3).describe('ISO 4217, e.g. EUR.'),
    type_code: z.string().optional().describe('380 invoice (default), 381 credit note, 384 corrected invoice.'),
    buyer_reference: z.string().optional().describe('For XRechnung: the Leitweg-ID (required there).'),
    delivery_date: z.string().optional().describe('YYYY-MM-DD.'),
    notes: z.array(z.string()).optional(),
    seller: party,
    buyer: party,
    payment: z
      .object({
        iban: z.string().optional(),
        bic: z.string().optional(),
        account_name: z.string().optional(),
        terms: z.string().optional().describe('Payment terms text. Either terms or due_date is required when an amount is due.'),
        due_date: z.string().optional().describe('YYYY-MM-DD.'),
        reference: z.string().optional(),
      })
      .passthrough()
      .optional(),
    lines: z
      .array(
        z
          .object({
            name: z.string().min(1),
            quantity: decimal,
            unit_price: decimal.describe('Net price per unit.'),
            unit_code: z.string().optional().describe('UN/ECE Rec 20: C62 piece (default), HUR hour, DAY day, KGM kilogram.'),
            description: z.string().optional(),
            vat: z
              .object({
                category: z.enum(['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M']).optional().describe('S standard (default), Z zero rated, E exempt, AE reverse charge, K intra-community, G export, O not subject.'),
                rate: decimal.optional().describe('Percent, e.g. 19. Required for S.'),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1)
      .max(2000),
  })
  .passthrough()
  .describe('The structured invoice (EN 16931). Totals are computed from the lines. Other fields of the API EInvoice schema (allowances, charges, delivery, billing_period, preceding_invoice, ...) are passed through.');

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function failure(err: unknown): CallToolResult {
  if (err instanceof CastPdfApiError) {
    const hint =
      err.status === 401
        ? ' Check the CASTPDF_API_KEY environment variable of the MCP server.'
        : err.status === 404
          ? ' Use list_templates or list_documents to find valid ids.'
          : '';
    const details = err.details ? ` Details: ${JSON.stringify(err.details)}` : '';
    return { isError: true, content: [{ type: 'text', text: `CastPDF error ${err.status} ${err.code}: ${err.message}.${hint}${details}${err.docsUrl ? ` Docs: ${err.docsUrl}` : ''}` }] };
  }
  return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error)?.message ?? String(err)}` }] };
}

const invalid = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: `Invalid input: ${message}` }] });

interface PdfJson {
  id?: string;
  status?: string;
  url?: string | null;
  expires_at?: string | null;
  pages?: number | null;
  bytes?: number | null;
  test?: boolean;
  filename?: string;
  warnings?: unknown[];
  e_invoice?: unknown;
  template_id?: string | null;
  error_code?: string | null;
  created_at?: string;
}

function pdfSummary(pdf: PdfJson) {
  return {
    id: pdf.id,
    status: pdf.status,
    download_url: pdf.url,
    expires_at: pdf.expires_at,
    filename: pdf.filename,
    pages: pdf.pages,
    bytes: pdf.bytes,
    test: pdf.test,
    ...(pdf.e_invoice ? { e_invoice: pdf.e_invoice } : {}),
    ...(pdf.warnings?.length ? { warnings: pdf.warnings } : {}),
  };
}

function pdfResult(pdf: PdfJson): CallToolResult {
  const summary = pdfSummary(pdf);
  const note = pdf.test ? ' This is a TEST document (watermarked, not counted).' : '';
  return {
    content: [
      { type: 'text', text: `PDF ready: ${pdf.url}\nThe link is signed and valid until ${pdf.expires_at}.${note}` },
      { type: 'text', text: JSON.stringify(summary, null, 2) },
    ],
  };
}

export interface ServerOptions extends ApiOptions {}

/** The CastPDF MCP server with its six tools. One instance per connection (stdio) or per request (stateless HTTP). */
export function createServer(opts: ServerOptions): McpServer {
  const api = new CastPdfApi(opts);
  const server = new McpServer(
    { name: 'castpdf', title: 'CastPDF', version: VERSION, websiteUrl: 'https://castpdf.com' },
    {
      instructions:
        'CastPDF renders PDFs from saved templates (Liquid/HTML with sample data) or from raw HTML, and issues EU e-invoices (ZUGFeRD, Factur-X, XRechnung). Typical flow: list_templates, then get_template_fields to learn the data shape, then create_pdf with template_id and data. Documents are test documents (watermarked, free) unless the user explicitly asks for a live one. Results are signed download links that expire; share the link with the user.',
    },
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List PDF templates',
      description:
        'Lists the PDF templates saved in the CastPDF account (id, name, current version, updated_at). Use it to find the template_id for create_pdf, then call get_template_fields to see which data the template expects.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 50.'),
        offset: z.number().int().min(0).optional().describe('Templates to skip, for paging.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, offset }) => {
      try {
        const page = await api.get<{ data?: Array<Record<string, unknown>>; has_more?: boolean }>('/v1/templates', { limit, offset });
        const templates = (page.data ?? []).map((t) => ({ id: t.id, name: t.name, current_version: t.current_version, pinned_version: t.pinned_version, updated_at: t.updated_at }));
        return json({ templates, has_more: page.has_more ?? false });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_template_fields',
    {
      title: 'Get the data fields of a template',
      description:
        "Returns the fields a template expects, read from its sample data: scalar fields by dotted path (e.g. customer.name) with type and sample value, and line_items (arrays of objects, e.g. invoice positions) with the fields of one item. Build the `data` object for create_pdf from this: nest dotted paths as objects (customer.name becomes { \"customer\": { \"name\": ... } }) and send line items as arrays of objects. Fields left out are rendered empty.",
      inputSchema: {
        template_id: uuid.describe('The template id from list_templates.'),
        version: z.number().int().min(1).optional().describe('A template version; default the current one.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ template_id, version }) => {
      try {
        const fields = await api.get<Record<string, unknown>>(`/v1/templates/${template_id}/fields`, { version });
        // `tree` repeats the same fields as a form layout for no-code tools; agents do not need it
        const { tree: _tree, tree_truncated: _truncated, ...rest } = fields;
        return json(rest);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'create_pdf',
    {
      title: 'Create a PDF',
      description:
        'Renders a PDF and returns a signed download URL (valid until expires_at). Give EITHER template_id with data (the usual way: see get_template_fields for the data shape) OR raw html (with optional css; the html may use Liquid tags such as {{ name }} filled from data). By default it makes a TEST document (watermarked, not counted); set test to false only when the user explicitly asks for a live/final document.',
      inputSchema: {
        template_id: uuid.optional().describe('A template id from list_templates. Leave out when giving html.'),
        data: z.record(z.string(), z.unknown()).optional().describe('The values for the template, as a JSON object (nested objects and arrays allowed). Left out: the template sample data is used.'),
        html: z.string().min(1).optional().describe('Raw HTML to render instead of a template (a full document or a fragment).'),
        css: z.string().optional().describe('CSS for raw html. Not allowed with template_id (a template carries its own CSS).'),
        template_version: z.number().int().min(1).optional().describe('Render this template version instead of the pinned or current one.'),
        filename,
        ...pageOptions,
        test: testFlag,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const hasTemplate = input.template_id !== undefined;
      const hasHtml = input.html !== undefined;
      if (hasTemplate === hasHtml) return invalid('give exactly one of template_id or html.');
      if (hasTemplate && input.css !== undefined) return invalid("css can't be combined with template_id; the template carries its own CSS.");
      if (!hasTemplate && input.template_version !== undefined) return invalid('template_version needs template_id.');
      try {
        const pdf = await api.post<PdfJson>('/v1/pdf', { ...stripUndefined(input), response: 'url' });
        return pdfResult(pdf);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'create_e_invoice',
    {
      title: 'Create an EU e-invoice',
      description:
        'Issues a structured invoice as an EU e-invoice and returns a signed download URL. standard: zugferd or factur-x give a PDF/A-3b with the XML embedded (readable by people and machines; for Germany prefer zugferd); xrechnung-cii or xrechnung-ubl give the XRechnung XML only (German public sector; needs invoice.buyer_reference = Leitweg-ID and electronic_address on seller and buyer). Totals and VAT are computed from the lines. The PDF uses the built-in invoice layout unless template_id is given. By default a TEST document (watermarked, not counted); set test to false only when the user explicitly asks for a live invoice.',
      inputSchema: {
        standard: z.enum(['zugferd', 'factur-x', 'xrechnung-cii', 'xrechnung-ubl']).describe('zugferd / factur-x: PDF with embedded XML. xrechnung-*: XML only.'),
        profile: z.enum(['minimum', 'basic-wl', 'basic', 'en16931', 'extended', 'xrechnung']).optional().describe('Default en16931 (zugferd/factur-x) or xrechnung (xrechnung-*). Leave out unless the user asks.'),
        invoice,
        template_id: uuid.optional().describe('Optional: a template for the visible PDF instead of the built-in invoice layout.'),
        filename,
        test: testFlag,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ standard, profile, invoice: inv, template_id, filename: name, test }) => {
      try {
        const body = stripUndefined({ template_id, filename: name, test, response: 'url', e_invoice: stripUndefined({ standard, profile, invoice: inv }) });
        const pdf = await api.post<PdfJson>('/v1/pdf', body);
        return pdfResult(pdf);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List recent documents',
      description:
        'Lists generated documents (PDFs and e-invoices), newest first: id, status (queued, processing, succeeded, failed, canceled), pages, test flag, template, created_at, and a signed download URL while the file is stored. Page with next_before.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 20.'),
        before: z.string().optional().describe('The next_before value of the previous page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, before }) => {
      try {
        const page = await api.get<{ data?: PdfJson[]; next_before?: string | null }>('/v1/documents', { limit, before });
        return json({ documents: (page.data ?? []).map(documentSummary), next_before: page.next_before ?? null });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get a document',
      description: 'Looks up one generated document by id: status, error code if it failed, page count, and a fresh signed download URL while the file is stored.',
      inputSchema: { id: uuid.describe('The document id (from create_pdf or list_documents).') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return json(documentSummary(await api.get<PdfJson>(`/v1/pdf/${id}`)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

function documentSummary(doc: PdfJson) {
  return {
    id: doc.id,
    status: doc.status,
    download_url: doc.url ?? null,
    expires_at: doc.expires_at ?? null,
    pages: doc.pages ?? null,
    test: doc.test,
    template_id: doc.template_id ?? null,
    error_code: doc.error_code ?? null,
    created_at: doc.created_at,
  };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
