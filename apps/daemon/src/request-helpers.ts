import type { Context } from 'hono';
import type { ServiceResult } from '@kb-2/vault-service';

export function readSpliceRequest(body: { body: Record<string, unknown> }): ServiceResult<{
  baseline: string;
  request: {
    oldText: string;
    newText: string;
    before?: string;
    after?: string;
    occurrence?: number;
  };
}> {
  const baseline = readRequiredString(body.body, 'baseline');
  if (!baseline.ok) return baseline;
  const oldText = readRequiredString(body.body, 'old_text');
  if (!oldText.ok) return oldText;
  const newText = readRequiredString(body.body, 'new_text');
  if (!newText.ok) return newText;
  if (body.body.before !== undefined && typeof body.body.before !== 'string') {
    return invalidRequest('before must be a string when provided');
  }
  if (body.body.after !== undefined && typeof body.body.after !== 'string') {
    return invalidRequest('after must be a string when provided');
  }
  if (
    body.body.occurrence !== undefined &&
    !(typeof body.body.occurrence === 'number' && Number.isInteger(body.body.occurrence))
  ) {
    return invalidRequest('occurrence must be an integer when provided');
  }
  return {
    ok: true,
    baseline: baseline.value,
    request: {
      oldText: oldText.value,
      newText: newText.value,
      ...(typeof body.body.before === 'string' ? { before: body.body.before } : {}),
      ...(typeof body.body.after === 'string' ? { after: body.body.after } : {}),
      ...(typeof body.body.occurrence === 'number' && Number.isInteger(body.body.occurrence)
        ? { occurrence: body.body.occurrence }
        : {})
    }
  };
}

export function queryNumber(context: Context, name: string): number | undefined {
  const raw = context.req.query(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function readOptionalJsonContent(request: Request): Promise<string | undefined> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }

  const body = await request.json().catch(() => undefined) as { content?: unknown } | undefined;
  return typeof body?.content === 'string' ? body.content : undefined;
}

export async function requestTextContent(request: Request): Promise<ServiceResult<{ content: string }>> {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body = await readJsonObject(request);
    if (!body.ok) return body;
    const content = readRequiredString(body.body, 'content');
    return content.ok ? { ok: true, content: content.value } : content;
  }

  return { ok: true, content: await request.text() };
}

export async function readJsonObject(request: Request): Promise<ServiceResult<{ body: Record<string, unknown> }>> {
  const parsed = await request.json().catch(() => undefined) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidRequest('request body must be a JSON object');
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

export function readRequiredString(body: Record<string, unknown>, field: string): ServiceResult<{ value: string }> {
  return typeof body[field] === 'string'
    ? { ok: true, value: body[field] }
    : invalidRequest(`${field} must be a string`);
}

export function filePathParam(pathname: string, prefix: string, suffix = ''): string {
  const withoutPrefix = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  const withoutSuffix = suffix.length > 0 && withoutPrefix.endsWith(suffix)
    ? withoutPrefix.slice(0, -suffix.length)
    : withoutPrefix;
  return decodeURIComponent(withoutSuffix);
}

function invalidRequest(message: string): ServiceResult<never> {
  return { ok: false, error: 'invalid_request', message };
}
