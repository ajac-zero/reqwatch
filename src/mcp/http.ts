import { z } from "zod";
import { checkRateLimit, type Authenticator } from "../auth";
import { authenticateAny, oauthConfigured } from "../oauth";
import type { Env } from "../index";
import { TOOLS, ToolError, toolList } from "./tools";

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const E = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 } as const;

const RpcMessage = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
const rpcResult = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });

const origin = (req: Request) => new URL(req.url).origin;

export function protectedResourceMetadata(req: Request, env: Env): Response {
  return Response.json({
    resource: `${origin(req)}/mcp`,
    authorization_servers: env.AUTH_ISSUER ? [env.AUTH_ISSUER] : oauthConfigured(env) ? [origin(req)] : [],
    bearer_methods_supported: ["header"],
  });
}

const unauthorized = (req: Request) =>
  Response.json({ error: "unauthorized" }, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource"` },
  });

export async function handleMcpRoute(req: Request, env: Env, authenticate: Authenticator = authenticateAny): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/.well-known/oauth-protected-resource") {
    return req.method === "GET" ? protectedResourceMetadata(req, env) : new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  const auth = await authenticate(req, env);
  if (!auth) return unauthorized(req);
  const wait = await checkRateLimit(env.DB, auth.user_id);
  if (wait !== null) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return rpcError(null, E.parse, "Parse error: body is not valid JSON", 400);
  }
  const msg = RpcMessage.safeParse(raw);
  if (!msg.success) return rpcError(null, E.request, "Invalid Request: expected a single JSON-RPC 2.0 message", 400);
  const { id, method, params } = msg.data;

  // Notifications and client responses get no body.
  if (method === undefined || id === undefined) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion = typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "reqwatch", version: "0.0.1" },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolList() });
    case "tools/call": {
      const p = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
      if (!p.success) return rpcError(id, E.params, "Invalid params: expected {name: string, arguments?: object}");
      const tool = TOOLS.find((t) => t.name === p.data.name);
      if (!tool) return rpcError(id, E.params, `Unknown tool: ${p.data.name}`);
      const toolResult = (text: string, isError: boolean, structured?: unknown) =>
        rpcResult(id, { content: [{ type: "text", text }], ...(structured === undefined ? {} : { structuredContent: structured }), isError });
      if (!auth.scopes.includes(tool.scope)) return toolResult(`forbidden: token lacks the '${tool.scope}' scope`, true);
      const args = tool.input.safeParse(p.data.arguments ?? {});
      if (!args.success) {
        return toolResult(`invalid_arguments: ${args.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
      }
      try {
        const out = await tool.run({ db: env.DB, user_id: auth.user_id, scopes: auth.scopes, webhook_kek: env.WEBHOOK_KEK }, args.data as never);
        const text = (out as { warning?: string }).warning ? `${(out as { warning: string }).warning}\n${JSON.stringify(out)}` : JSON.stringify(out);
        return toolResult(text, false, out);
      } catch (e) {
        if (e instanceof ToolError) return toolResult(e.message, true);
        if (e instanceof z.ZodError) {
          return toolResult(`invalid_arguments: ${e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
        }
        if (e instanceof Error && e.message.startsWith("interest_limit:")) return toolResult(e.message, true);
        return rpcError(id, E.internal, "Internal error");
      }
    }
    default:
      return rpcError(id, E.method, `Method not found: ${method}`);
  }
}
