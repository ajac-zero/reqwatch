import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { makeDb } from "./helpers";

let ctx: ReturnType<typeof makeDb>;
let env: Env;
beforeEach(() => {
  ctx = makeDb();
  env = { DB: ctx.db } as Env;
});

const post = (body: string, ip = "1.2.3.4", type = "application/x-www-form-urlencoded") =>
  worker.fetch(
    new Request("https://rw.test/api/waitlist", { method: "POST", headers: { "content-type": type, "cf-connecting-ip": ip }, body }),
    env,
  );
const rows = () => ctx.raw.prepare("SELECT email FROM waitlist").all() as { email: string }[];
const loc = (r: Response) => [r.status, r.headers.get("location")];

describe("POST /api/waitlist", () => {
  it("stores a lowercased email and redirects to joined", async () => {
    expect(loc(await post("email=%20Foo%40Example.COM%20"))).toEqual([303, "/?joined=1"]);
    expect(rows()).toEqual([{ email: "foo@example.com" }]);
    const r = ctx.raw.prepare("SELECT ip_hash, source FROM waitlist").get() as any;
    expect(r.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.source).toBe("landing");
  });

  it("dedups but still reports joined", async () => {
    await post("email=a%40b.co");
    expect(loc(await post("email=A%40B.co"))).toEqual([303, "/?joined=1"]);
    expect(rows()).toHaveLength(1);
  });

  it.each([
    ["invalid", "email=nope"],
    ["no dot in domain", "email=a%40b"],
    ["two @", "email=a%40b%40c.co"],
    ["missing", "x=1"],
    ["too long", `email=${"a".repeat(250)}%40b.co`],
  ])("rejects %s", async (_n, body) => {
    expect(loc(await post(body))).toEqual([303, "/?error=1"]);
    expect(rows()).toHaveLength(0);
  });

  it("rejects non-form content types", async () => {
    expect(loc(await post('{"email":"a@b.co"}', "1.2.3.4", "application/json"))).toEqual([303, "/?error=1"]);
    expect(rows()).toHaveLength(0);
  });

  it("rate limits the 6th request per IP per hour, not other IPs", async () => {
    for (let i = 0; i < 5; i++) expect(loc(await post(`email=u${i}%40b.co`))).toEqual([303, "/?joined=1"]);
    expect(loc(await post("email=u9%40b.co"))).toEqual([303, "/?error=1"]);
    expect(rows()).toHaveLength(5);
    expect(loc(await post("email=u9%40b.co", "9.9.9.9"))).toEqual([303, "/?joined=1"]);
  });

  it("returns 405 for other methods", async () => {
    const r = await worker.fetch(new Request("https://rw.test/api/waitlist"), env);
    expect(r.status).toBe(405);
  });
});

describe("static assets", () => {
  it("is configured to serve ./public with Worker-first API routes", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    expect(toml).toMatch(/directory = "\.\/public"/);
    for (const p of ["/api/*", "/mcp", "/health"]) expect(toml).toContain(`"${p}"`);
    expect(readFileSync("public/index.html", "utf8")).toContain("Join waitlist");
  });
});
