import type { PsiRequest } from "./audit.ts";

export const psiRequest = (key: string): PsiRequest => async ({ url, strategy, categories }) => {
  const q = new URLSearchParams({ url, strategy, key });
  for (const c of categories) q.append("category", c);
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    // Never include the request URL here: it carries the API key.
    throw Object.assign(new Error(`PSI ${res.status}: ${body?.error?.message ?? res.statusText}`), { status: res.status });
  }
  return res.json();
};
