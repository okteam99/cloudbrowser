import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { definitions } from './tools.js';
import { publicError, ToolError } from './errors.js';

export type Dispatch = (
  owner: string,
  name: string,
  args: any,
  operationId: string,
) => Promise<any>;
export type ToolResult = {
  operation_id: string;
  status: 'succeeded' | 'failed' | 'unknown';
  data: any;
  error: { code: string; message: string; issues?: { path: string; message: string }[] } | null;
  note?: string;
};
export function failedCall(operationId: string, code: string, message: string): ToolResult {
  return { operation_id: operationId, status: 'failed', data: null, error: { code, message } };
}
// Both protocol adapters use the same validation, operation IDs, dispatcher and result envelope.
export async function invokeTool(
  owner: string,
  name: string,
  raw: unknown,
  dispatch: Dispatch,
  operationId: string = randomUUID(),
): Promise<ToolResult> {
  if (!Object.hasOwn(definitions, name))
    return failedCall(operationId, 'UNKNOWN_TOOL', 'Unknown tool.');
  try {
    const args = definitions[name].schema.parse(raw);
    return await dispatch(owner, name, args, operationId);
  } catch (e) {
    if (e instanceof z.ZodError)
      return {
        ...failedCall(operationId, 'INVALID_ARGUMENT', 'Invalid arguments.'),
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'Invalid arguments.',
          issues: e.issues
            .slice(0, 20)
            .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      };
    if (e instanceof ToolError) return { ...failedCall(operationId, e.code, e.message) };
    return {
      operation_id: operationId,
      status: 'unknown',
      data: null,
      error: publicError(e),
      note: 'Use get_operation with operation_id before retrying.',
    };
  }
}
export function toolHttpStatus(result: ToolResult) {
  if (result.status === 'succeeded') return 200;
  if (result.status === 'unknown') return result.error?.code === 'TIMEOUT' ? 504 : 503;
  const code = result.error?.code ?? '';
  if (
    [
      'UNKNOWN_TOOL',
      'INSTANCE_NOT_FOUND',
      'PAGE_NOT_FOUND',
      'ARTIFACT_NOT_FOUND',
      'PROXY_NOT_FOUND',
      'DEVICE_PROFILE_NOT_FOUND',
      'OPERATION_NOT_FOUND',
      'REQUEST_NOT_FOUND',
      'FRAME_NOT_FOUND',
    ].includes(code)
  )
    return 404;
  if (code === 'REQUEST_TOO_LARGE' || code === 'ARTIFACT_TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (code === 'INVALID_ARGUMENT' || code.startsWith('INVALID_')) return 400;
  if (code === 'TIMEOUT' || code === 'SCRIPT_TIMEOUT') return 504;
  if (code === 'PROXY_CONNECTION_FAILED') return 502;
  if (code === 'OPERATION_FAILED') return 500;
  return 409;
}
