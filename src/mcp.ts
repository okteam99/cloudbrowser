import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { definitions } from './tools.js';
import { invokeTool, type Dispatch } from './tool-api.js';
export type { Dispatch } from './tool-api.js';
export function createMcpServer(owner: string, call: Dispatch) {
  const server = new McpServer({ name: 'cloudbrowser', version: '0.16.0' });
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
        const result = await invokeTool(owner, name, args, call, operationId);
        const content: any[] = [{ type: 'text', text: JSON.stringify(result) }];
        if (name === 'screenshot' && result.status === 'succeeded' && result.data?.preview?.id) {
          const preview = await invokeTool(
            owner,
            'get_artifact',
            { artifact_id: result.data.preview.id, offset: 0, length: 524288 },
            call,
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
      },
    );
  }
  return server;
}
