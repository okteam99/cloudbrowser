import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { definitions } from './tools.js';
import { publicError } from './errors.js';
export type Dispatch = (
  owner: string,
  name: string,
  args: any,
  operationId: string,
) => Promise<any>;
export function createMcpServer(owner: string, call: Dispatch) {
  const server = new McpServer({ name: 'cloudbrowser', version: '0.10.1' });
  for (const [name, d] of Object.entries(definitions)) {
    // SDK discovery requires an object at the root. Keep full cross-field validation in the handler.
    let inputSchema = d.schema;
    while (inputSchema instanceof z.ZodEffects) inputSchema = inputSchema.innerType();
    server.registerTool(
      name,
      {
        description: d.description,
        inputSchema: inputSchema as any,
        annotations: {
          readOnlyHint: !!d.readOnly,
          destructiveHint: !d.readOnly,
          openWorldHint: true,
        },
      },
      async (args: any): Promise<CallToolResult> => {
        const operationId = randomUUID();
        try {
          const result = await call(owner, name, d.schema.parse(args), operationId);
          const content: any[] = [{ type: 'text', text: JSON.stringify(result) }];
          if (name === 'screenshot' && result.status === 'succeeded' && result.data?.preview?.id) {
            const preview = await call(
              owner,
              'get_artifact',
              { artifact_id: result.data.preview.id, offset: 0, length: 524288 },
              randomUUID(),
            );
            if (preview.status === 'succeeded' && preview.data.complete)
              content.push({
                type: 'image',
                mimeType: 'image/jpeg',
                data: preview.data.data_base64,
              });
          }
          if (
            name === 'get_artifact' &&
            result.data?.mime === 'image/png' &&
            result.data.offset === 0 &&
            result.data.complete &&
            Buffer.from(result.data.data_base64, 'base64')
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            content.push({ type: 'image', mimeType: 'image/png', data: result.data.data_base64 });
          return { content, structuredContent: result, isError: result.status !== 'succeeded' };
        } catch (e) {
          const invalid = e instanceof z.ZodError;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  operation_id: operationId,
                  status: invalid ? 'failed' : 'unknown',
                  error: invalid
                    ? { code: 'INVALID_ARGUMENT', message: 'Invalid arguments.' }
                    : publicError(e),
                  note: invalid
                    ? undefined
                    : 'Use get_operation with operation_id before retrying.',
                }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}
