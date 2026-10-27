import { readFile } from 'node:fs/promises';
import { definitions } from './tools.js';

export async function toolCatalog(baseUrl: string) {
  const saved = JSON.parse(
    await readFile(new URL('../docs/mcp-tools.json', import.meta.url), 'utf8'),
  );
  return {
    base_url: `${baseUrl}/api`,
    guide_url: `${baseUrl}/docs/agent-guide.md`,
    tools: saved.tools.map((tool: any) => ({
      ...tool,
      description: definitions[tool.name].description,
      method: 'POST',
      url: `${baseUrl}/api/tools/${tool.name}`,
    })),
  };
}
function inputComponent(value: any, name: string): any {
  if (Array.isArray(value)) return value.map((item) => inputComponent(item, name));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema')
      .map(([key, child]) => [
        key,
        key === '$ref' && typeof child === 'string' && child.startsWith('#')
          ? `#/components/schemas/${name}${child.slice(1)}`
          : inputComponent(child, name),
      ]),
  );
}
export async function toolOpenApi(baseUrl: string) {
  const { tools } = await toolCatalog(baseUrl);
  const schemas: Record<string, any> = {
    ToolResult: {
      type: 'object',
      required: ['operation_id', 'status', 'data', 'error'],
      properties: {
        operation_id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['succeeded', 'failed', 'unknown'] },
        data: { description: 'Tool-specific output; null on failure. See the shared Agent guide.' },
        error: {
          type: ['object', 'null'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            issues: { type: 'array', items: { type: 'object' } },
          },
        },
        note: { type: 'string' },
      },
    },
  };
  const paths: Record<string, any> = {};
  for (const tool of tools) {
    const name = `${tool.name}Arguments`;
    schemas[name] = inputComponent(tool.inputSchema, name);
    const responses = Object.fromEntries(
      Object.entries({
        '200': 'Succeeded',
        '400': 'Invalid JSON or arguments',
        '401': 'Bearer token required',
        '403': 'Cross-site origin rejected',
        '404': 'Tool or resource not found',
        '405': 'Use POST',
        '409': 'State conflict or operation ID reused with different arguments',
        '413': 'Request or artifact too large',
        '415': 'Use application/json',
        '500': 'Operation failed',
        '502': 'Proxy failed',
        '503': 'Outcome unknown',
        '504': 'Timeout; inspect state before retrying',
      }).map(([code, description]) => [
        code,
        {
          description,
          content: {
            'application/json': {
              schema:
                code === '403'
                  ? { type: 'object', properties: { error: { type: 'string' } } }
                  : { $ref: '#/components/schemas/ToolResult' },
            },
          },
        },
      ]),
    );
    paths[`/api/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        tags: ['Browser tools'],
        parameters: [
          {
            in: 'header',
            name: 'Idempotency-Key',
            required: false,
            schema: { type: 'string', format: 'uuid' },
            description:
              'Optional operation ID. Action retries reuse the cached result while retained (last 500 actions, until restart). Read-only diagnostic queries may execute again.',
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
        },
        responses,
      },
    };
  }
  return {
    openapi: '3.1.1',
    info: {
      title: 'cloudbrowser Tool API',
      version: '0.19.0',
      description:
        'The HTTP and MCP adapters share browser tools, validation, instance state and operation logs.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    externalDocs: {
      description: 'Shared MCP & API Agent guide (public Markdown)',
      url: `${baseUrl}/docs/agent-guide.md`,
    },
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
  };
}
