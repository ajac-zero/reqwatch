import type { Db } from "./db";
import type { R2Like } from "./poll";
import { handleAdminTokens } from "./auth";
import { handleMcpRoute } from "./mcp/http";
import { handleWaitlist } from "./waitlist";
import { OAUTH_PATHS, handleOAuthRoute } from "./oauth";
import { handleQueue, health, scheduled } from "./worker";

export interface QueueLike<T> {
  send(body: T): Promise<void>;
}

export interface Env {
  DB: Db;
  FETCH_QUEUE: QueueLike<FetchMessage>;
  /** Optional raw snapshot bucket. */
  SNAPSHOTS?: R2Like;
  /** Enables POST /admin/tokens when set. */
  ADMIN_SECRET?: string;
  /** OAuth issuer advertised in /.well-known/oauth-protected-resource. */
  AUTH_ISSUER?: string;
  /** GitHub OAuth app credentials; hosted OAuth login is enabled only when both are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Key-encryption secret for webhook signing secrets (AES-GCM). Webhook delivery is unavailable when unset. */
  WEBHOOK_KEK?: string;
}

export interface FetchMessage {
  companyId: number;
}

export interface MessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/health") return health(env);
    if (path === "/mcp" || path === "/.well-known/oauth-protected-resource") return handleMcpRoute(req, env);
    if (OAUTH_PATHS.includes(path)) return handleOAuthRoute(req, env);
    if (path === "/admin/tokens") return handleAdminTokens(req, env);
    if (path === "/api/waitlist") return handleWaitlist(req, env);
    return new Response("reqwatch", { status: 200 });
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await scheduled(env);
  },
  async queue(batch: { messages: MessageLike<FetchMessage>[] }, env: Env): Promise<void> {
    await handleQueue(batch.messages, env);
  },
};
