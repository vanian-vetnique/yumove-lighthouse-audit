import { test } from "node:test";
import assert from "node:assert/strict";
import { psiRequest } from "../src/psi.ts";

const call = () => psiRequest("SECRET-KEY")({ url: "https://a.com/", strategy: "mobile", categories: ["seo"] });

test("PSI errors carry the HTTP status for retry and never leak the API key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }));
  await assert.rejects(call(), (e: any) => e.status === 429 && /quota/.test(e.message) && !e.message.includes("SECRET-KEY"));
});

test("a network failure has no status (retried) and no key in the message", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(call(), (e: any) => e.status === undefined && !e.message.includes("SECRET-KEY"));
});
