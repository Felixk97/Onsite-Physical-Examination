import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID } from "node:crypto";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const same = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const uid = () => randomUUID().replace(/-/g, "").slice(0, 16);
const safe = (s) => typeof s === "string" && /^[\w-]{1,40}$/.test(s);
const RANGE = { age: [1, 120], height: [50, 250], weight: [10, 400], sys: [50, 300], dia: [30, 200] };
const MAX_PER_COMPANY = 3000;

function clean(b) {
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name) return { error: "name" };
  const out = { name };
  for (const k in RANGE) {
    const raw = b[k];
    if (raw === null || raw === undefined || raw === "") { out[k] = null; continue; }
    const n = Number(raw);
    if (!isFinite(n) || n < RANGE[k][0] || n > RANGE[k][1]) return { error: k };
    out[k] = n;
  }
  if ((out.height == null) !== (out.weight == null) || (out.sys == null) !== (out.dia == null)) return { error: "pair" };
  if (out.sys && out.dia && out.sys <= out.dia) return { error: "bp" };
  return { rec: out };
}

export default async (req) => {
  const store = getStore("screening");
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const getJ = (key) => store.get(key, { type: "json" });
  const company = (id) => (safe(id) ? getJ("c:" + id) : null);
  const list = async (prefix) => {
    const { blobs } = await store.list({ prefix });
    return (await Promise.all(blobs.map((b) => getJ(b.key)))).filter(Boolean);
  };

  // ---------- public (staff self-entry): can only create / read / update ONE record ----------
  if (action === "company") {
    const c = await company(url.searchParams.get("id"));
    return c ? J({ name: c.name, open: c.open !== false }) : J({ error: "not found" }, 404);
  }
  if (action === "mine") {
    const cid = url.searchParams.get("c"), id = url.searchParams.get("id");
    const rec = safe(cid) && safe(id) ? await getJ(`r:${cid}:${id}`) : null;
    return rec ? J({ rec }) : J({ error: "not found" }, 404);
  }
  if (action === "submit" || action === "update") {
    const c = await company(body.company);
    if (!c || c.open === false) return J({ error: "closed" }, 403);
    if (body.website) return J({ ok: true }); // honeypot for bots
    const { rec, error } = clean(body);
    if (error) return J({ error }, 400);
    if (action === "submit") {
      if (!body.consent) return J({ error: "consent" }, 400);
      const { blobs } = await store.list({ prefix: `r:${c.id}:` });
      if (blobs.length >= MAX_PER_COMPANY) return J({ error: "full" }, 429);
      const id = uid(), now = Date.now();
      await store.setJSON(`r:${c.id}:${id}`, { ...rec, id, company: c.id, created: now, updated: now, consent: now });
      return J({ id });
    }
    if (!safe(body.id)) return J({ error: "bad id" }, 400);
    const key = `r:${c.id}:${body.id}`, old = await getJ(key);
    if (!old) return J({ error: "not found" }, 404);
    await store.setJSON(key, { ...old, ...rec, updated: Date.now() });
    return J({ ok: true });
  }

  // ---------- admin only ----------
  const adminOk = process.env.ADMIN_CODE && same(req.headers.get("x-admin-code"), process.env.ADMIN_CODE);
  if (!adminOk) return J({ error: "unauthorized" }, 401);

  if (action === "all") return J({ companies: await list("c:"), records: await list("r:") });
  if (action === "company_put") {
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return J({ error: "name" }, 400);
    const id = safe(body.id) ? body.id : uid();
    const old = await getJ("c:" + id);
    await store.setJSON("c:" + id, { id, name, open: body.open ?? old?.open ?? true, created: old?.created || Date.now() });
    return J({ ok: true, id });
  }
  if (action === "company_del" && safe(body.id)) {
    await store.delete("c:" + body.id);
    const { blobs } = await store.list({ prefix: `r:${body.id}:` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    return J({ ok: true });
  }
  if (action === "rec_del" && safe(body.company) && safe(body.id)) {
    await store.delete(`r:${body.company}:${body.id}`);
    return J({ ok: true });
  }
  if (action === "rec_put" && safe(body.company)) {
    const { rec, error } = clean(body);
    if (error) return J({ error }, 400);
    const id = safe(body.id) ? body.id : uid(), key = `r:${body.company}:${id}`, old = await getJ(key), now = Date.now();
    await store.setJSON(key, { ...old, ...rec, id, company: body.company, created: old?.created || now, updated: now });
    return J({ ok: true, id });
  }
  return J({ error: "bad action" }, 400);
};

export const config = { path: "/api" };
