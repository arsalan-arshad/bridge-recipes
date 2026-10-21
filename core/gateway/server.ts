// Thin HTTP adapter around handleWebhook: reads the raw body (capped), answers with a status and no body.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleWebhook } from './handleWebhook.ts';
import type { GatewayDeps } from './types.ts';

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

// The webhook route as a plain request handler, so an app can mount it next to health routes.
export function createGatewayHandler(deps: GatewayDeps, opts: { path?: string; maxBodyBytes?: number } = {}): RequestHandler {
  const path = opts.path ?? '/webhooks/shopify';
  const max = opts.maxBodyBytes ?? 1_000_000;

  return (req, res) => {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    // Refuse an oversized body up front (declared length) or as soon as it overflows, then drop the connection instead of
    // draining it: an unauthenticated client must not be able to keep a connection busy streaming data we will discard.
    const refuse = () => {
      if (res.headersSent) return;
      res.writeHead(413, { Connection: 'close' }).end();
      res.once('finish', () => req.destroy());
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return refuse();
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > max) {
        tooBig = true;
        chunks.length = 0;
        refuse();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const { status } = await handleWebhook({ rawBody: Buffer.concat(chunks), headers: req.headers }, deps);
        res.writeHead(status).end();
      } catch {
        res.writeHead(500).end();
      }
    });
  };
}

export function createGatewayServer(deps: GatewayDeps, opts: { path?: string; maxBodyBytes?: number } = {}): Server {
  return createServer(createGatewayHandler(deps, opts));
}
