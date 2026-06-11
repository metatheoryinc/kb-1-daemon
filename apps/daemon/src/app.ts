import { Hono, type Context } from 'hono';
import { DocumentSessionManager, type OneFileDocumentSession } from '@kb-2/doc-session';
import {
  createLocalMcpEndpoint,
  type LocalMcpEndpoint
} from '@kb-2/local-mcp';
import { createVaultService, type LocalMcpVaultService, type ServiceErrorCode, type ServiceResult } from '@kb-2/vault-service';
import { resolve } from 'node:path';

import { SERVICE_NAME } from './config.js';
import {
  filePathParam,
  queryNumber,
  readJsonObject,
  readOptionalJsonContent,
  readRequiredString,
  readSpliceRequest,
  requestTextContent
} from './request-helpers.js';
import { readDaemonStatus } from './status.js';
import { missingUiBuildResponse, proxyUi, serveUi } from './ui-static.js';

const DEMO_DOCUMENT_PATH = 'demo-vault/hello-world.md';

export interface CreateAppOptions {
  statusFile: string;
  vaultRoot?: string;
  documentSessions?: DocumentSessionManager;
  vaultService?: LocalMcpVaultService;
  demoDocumentSession?: OneFileDocumentSession;
  mcpEndpoint?: LocalMcpEndpoint;
  webBuildDir?: string;
  webProxyTarget?: string;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const api = new Hono();

  api.get('/health', async (context) => {
    const status = await readDaemonStatus(options.statusFile);

    return context.json({
      ok: true,
      service: SERVICE_NAME,
      status
    });
  });

  if (options.demoDocumentSession) {
    api.get('/demo-document', async (context) => {
      const content = await options.demoDocumentSession!.getContent();

      return context.json({
        ok: true,
        document: DEMO_DOCUMENT_PATH,
        content
      });
    });

    api.post('/demo-document/reset', async (context) => {
      const requestedContent = await readOptionalJsonContent(context.req.raw);
      const content = await options.demoDocumentSession!.reset(requestedContent);

      return context.json({
        ok: true,
        document: DEMO_DOCUMENT_PATH,
        content
      });
    });
  }

  if (options.vaultRoot) {
    const vaultService = options.vaultService ?? createVaultService({
      vaultRoot: options.vaultRoot,
      documentSessions: options.documentSessions ?? new DocumentSessionManager({ root: options.vaultRoot })
    });
    const mcpEndpoint = options.mcpEndpoint ?? createLocalMcpEndpoint(vaultService);

    api.get('/vault', async (context) => {
      return mapServiceResult(context, await vaultService.vaultInfo());
    });

    api.get('/tree', async (context) => {
      const depthRaw = context.req.query('depth');
      const depth = depthRaw === undefined ? undefined : Number(depthRaw);
      return mapServiceResult(context, await vaultService.listFiles({
        under: context.req.query('under'),
        ...(depth !== undefined && Number.isInteger(depth) ? { depth } : {})
      }));
    });

    api.get('/search', async (context) => {
      return mapServiceResult(context, await vaultService.search({
        query: context.req.query('q') ?? '',
        under: context.req.query('under'),
        context: queryNumber(context, 'context'),
        limit: queryNumber(context, 'limit'),
        offset: queryNumber(context, 'offset')
      }));
    });

    api.get('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      return mapServiceResult(context, await vaultService.readNote({ path: filePath }));
    });

    api.put('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const content = await requestTextContent(context.req.raw);
      if (!content.ok) return mapServiceResult(context, content);
      const overwrite = context.req.query('overwrite') === 'true';
      return mapServiceResult(context, await vaultService.createNote({
        path: filePath,
        content: content.content,
        overwrite,
        actor: { kind: 'user' }
      }), overwrite ? 200 : 201);
    });

    api.delete('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const permanent = context.req.query('permanent') === 'true';
      return mapServiceResult(context, await vaultService.deleteNote({
        path: filePath,
        permanent,
        actor: { kind: 'user' }
      }));
    });

    api.post('/files/*', async (context) => {
      if (context.req.path.endsWith('/splice')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/splice');
        const body = await readJsonObject(context.req.raw);
        if (!body.ok) return mapServiceResult(context, body);
        const splice = readSpliceRequest(body);
        if (!splice.ok) return mapServiceResult(context, splice);
        return mapServiceResult(context, await vaultService.editNote({
          path: filePath,
          baseline: splice.baseline,
          oldText: splice.request.oldText,
          newText: splice.request.newText,
          before: splice.request.before,
          after: splice.request.after,
          occurrence: splice.request.occurrence,
          actor: { kind: 'user' }
        }));
      }

      if (context.req.path.endsWith('/append')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/append');
        const body = await readJsonObject(context.req.raw);
        if (!body.ok) return mapServiceResult(context, body);
        const content = readRequiredString(body.body, 'content');
        if (!content.ok) return mapServiceResult(context, content);
        return mapServiceResult(context, await vaultService.appendNote({
          path: filePath,
          content: content.value,
          actor: { kind: 'user' }
        }));
      }

      if (context.req.path.endsWith('/prepend')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/prepend');
        const body = await readJsonObject(context.req.raw);
        if (!body.ok) return mapServiceResult(context, body);
        const content = readRequiredString(body.body, 'content');
        if (!content.ok) return mapServiceResult(context, content);
        return mapServiceResult(context, await vaultService.prependNote({
          path: filePath,
          content: content.value,
          actor: { kind: 'user' }
        }));
      }

      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/files/', '/move');
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const to = readRequiredString(body.body, 'to');
      if (!to.ok) return mapServiceResult(context, to);
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      return mapServiceResult(context, await vaultService.moveNote({
        fromPath,
        toPath: to.value,
        actor: { kind: 'user' }
      }));
    });

    api.post('/folders', async (context) => {
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const folderPath = typeof body.body.path === 'string' ? body.body.path : '';
      return mapServiceResult(context, await vaultService.createFolder({
        path: folderPath,
        actor: { kind: 'user' }
      }), 201);
    });

    api.delete('/folders/*', async (context) => {
      const folderPath = filePathParam(context.req.path, '/api/folders/');
      const recursive = context.req.query('recursive') === 'true';
      const permanent = context.req.query('permanent') === 'true';
      return mapServiceResult(context, await vaultService.deleteFolder({
        path: folderPath,
        recursive,
        permanent,
        actor: { kind: 'user' }
      }));
    });

    api.post('/folders/*', async (context) => {
      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/folders/', '/move');
      const body = await readJsonObject(context.req.raw);
      if (!body.ok) return mapServiceResult(context, body);
      const to = readRequiredString(body.body, 'to');
      if (!to.ok) return mapServiceResult(context, to);
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      return mapServiceResult(context, await vaultService.moveFolder({
        fromPath,
        toPath: to.value,
        actor: { kind: 'user' }
      }));
    });

    app.all('/mcp', async (context) => {
      return mcpEndpoint.handleRequest(context.req.raw);
    });
  }

  app.route('/api', api);

  const webBuildDir = options.webBuildDir;
  const webProxyTarget = options.webProxyTarget;

  if (webProxyTarget || webBuildDir) {
    app.notFound(async (context) => {
      const { pathname } = new URL(context.req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      if (webProxyTarget) {
        return proxyUi(webProxyTarget, context.req.raw);
      }

      if (!webBuildDir) {
        return missingUiBuildResponse(resolve('apps/web/build'));
      }

      return serveUi(webBuildDir, pathname);
    });
  }

  return app;
}

function mapServiceResult(
  context: Context,
  result: ServiceResult,
  okStatus: 200 | 201 = 200
): Response {
  if (result.ok) {
    return context.json(result, okStatus);
  }

  return context.json(result, statusForServiceError(result.error));
}

function statusForServiceError(error: ServiceErrorCode): 400 | 404 | 409 | 413 | 500 {
  switch (error) {
    case 'invalid_path':
    case 'invalid_request':
      return 400;
    case 'not_found':
      return 404;
    case 'already_exists':
    case 'path_collision':
    case 'folder_not_empty':
      return 409;
    case 'entry_cap_exceeded':
    case 'too_large_splice':
    case 'too_large_document':
      return 413;
    case 'persist_failed':
      return 500;
    case 'stale_doc':
    case 'ambiguous':
      return 409;
  }
}
