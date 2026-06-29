// Cloudflare Worker entrypoint.
// Routes /api/* to the various data APIs; everything else falls back to static
// assets (the dashboard HTML and friends) via the ASSETS binding.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/records") {
      return handleStore(request, env, CHARGES_CONFIG);
    }
    if (url.pathname === "/api/revenue") {
      return handleStore(request, env, REVENUE_CONFIG);
    }
    if (url.pathname === "/api/corrections") {
      return handleCorrections(request, env);
    }
    if (url.pathname === "/api/sync-bq") {
      return handleBqSync(request, env);
    }
    if (url.pathname === "/api/rate-card") {
      return handleRateCard(request, env);
    }
    if (url.pathname === "/api/sync-vle") {
      return handleVleSync(request, env);
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    // Anything else: serve from the static assets bundle.
    return env.ASSETS.fetch(request);
  },

  // Scheduled handler — invoked by Cloudflare on the cron(s) declared in
  // wrangler.jsonc's `triggers.crons`. Runs the BC->BQ sync nightly so the
  // dashboard's revenue store stays fresh without anyone clicking a button.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const bq = await syncFromBq(env);
      console.log("[scheduled bq sync]", JSON.stringify({ cron: event.cron, ...bq }));
      const vle = await syncFromVle(env);
      console.log("[scheduled vle sync]", JSON.stringify({ cron: event.cron, ...vle }));
    })());
  },
};

// ---- Store configs ----
// Two parallel stores: shipping charges (existing) and BC shipping revenue (new).

const CHARGES_CONFIG = {
  kvKey: "all_charges_v1",
  // Stable dedup key for a UPS/DHL charge row.
  recordKey: r => [
    r.carrier || "UPS",
    r.invoiceNumber || "",
    r.tracking || "",
    r.chargeCat || "",
    r.chargeCode || "",
    r.chargeDesc || "",
    Number(r.net || 0).toFixed(2),
  ].join("|"),
};

const REVENUE_CONFIG = {
  kvKey: "revenue_v1",
  // Stable dedup key for a BC invoice line.
  // Document + line within document is unique by definition.
  recordKey: r => [
    r.documentNo || "",
    r.lineNo != null ? String(r.lineNo) : "",
    r.itemNo || "",
    Number(r.amount || 0).toFixed(2),
  ].join("|"),
};

// ---- Shared helpers ----

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth-Hash",
  };
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: corsHeaders(),
  });
}

function checkAuth(request, env) {
  const hash = request.headers.get("X-Auth-Hash");
  return hash && hash === env.AUTH_HASH;
}

// Generic handler: GET returns the stored array, POST appends-with-dedup,
// DELETE clears. Behaviour driven by `config` (kvKey + recordKey function).
async function handleStore(request, env, config) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!checkAuth(request, env)) {
    return unauthorized();
  }

  if (request.method === "GET") {
    const data = await env.CHARGES_KV.get(config.kvKey, { type: "json" });
    return new Response(JSON.stringify(data || []), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400, headers: corsHeaders() });
    }
    const incoming = Array.isArray(body) ? body : body.records;
    if (!Array.isArray(incoming)) {
      return new Response("Expected { records: [...] } or [...]", {
        status: 400,
        headers: corsHeaders(),
      });
    }

    const existing = (await env.CHARGES_KV.get(config.kvKey, { type: "json" })) || [];
    const seen = new Set(existing.map(config.recordKey));
    const fresh = [];
    for (const r of incoming) {
      const k = config.recordKey(r);
      if (!seen.has(k)) {
        seen.add(k);
        fresh.push(r);
      }
    }
    const merged = existing.concat(fresh);
    await env.CHARGES_KV.put(config.kvKey, JSON.stringify(merged));
    return new Response(
      JSON.stringify({ added: fresh.length, deduped: incoming.length - fresh.length, total: merged.length }),
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } },
    );
  }

  if (request.method === "DELETE") {
    await env.CHARGES_KV.delete(config.kvKey);
    return new Response(JSON.stringify({ cleared: true }), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
}

// ---- Corrections store ----
// Maps a stable chargeKey -> { ref1: "SO12345", updatedAt: "ISO timestamp", updatedBy: "ip-or-anon" }
// Applied on the dashboard side as a non-destructive overlay over carrier records.
// Stored under one KV key as a single JSON object (typical size: small).

const CORRECTIONS_KV_KEY = "corrections_v1";

async function handleCorrections(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!checkAuth(request, env)) {
    return unauthorized();
  }

  if (request.method === "GET") {
    const data = await env.CHARGES_KV.get(CORRECTIONS_KV_KEY, { type: "json" });
    return new Response(JSON.stringify(data || {}), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400, headers: corsHeaders() });
    }
    // Accept either { chargeKey, ref1 } for single, or { corrections: { key: ref1, ... } } for batch.
    const existing = (await env.CHARGES_KV.get(CORRECTIONS_KV_KEY, { type: "json" })) || {};
    const merged = { ...existing };
    const now = new Date().toISOString();
    const ip = request.headers.get("CF-Connecting-IP") || "anon";

    let count = 0;
    // Single correction: { chargeKey, ref1?, tracking? } — either field optional, both can be set together.
    if (body.chargeKey && (typeof body.ref1 === "string" || typeof body.tracking === "string")) {
      const prev = merged[body.chargeKey] || {};
      const entry = { ...prev, updatedAt: now, updatedBy: ip };
      if (typeof body.ref1 === "string") entry.ref1 = body.ref1;
      if (typeof body.tracking === "string") entry.tracking = body.tracking;
      merged[body.chargeKey] = entry;
      count = 1;
    // Batch: { corrections: { key: ref1Or{ref1?,tracking?}, ... } }
    } else if (body.corrections && typeof body.corrections === "object") {
      for (const [k, v] of Object.entries(body.corrections)) {
        const prev = merged[k] || {};
        const entry = { ...prev, updatedAt: now, updatedBy: ip };
        if (typeof v === "string") entry.ref1 = v;
        else if (v && typeof v === "object") {
          if (typeof v.ref1 === "string") entry.ref1 = v.ref1;
          if (typeof v.tracking === "string") entry.tracking = v.tracking;
        }
        merged[k] = entry;
        count++;
      }
    } else {
      return new Response("Expected { chargeKey, ref1?, tracking? } or { corrections: { key: ref1|{ref1?,tracking?}, ... } }",
        { status: 400, headers: corsHeaders() });
    }

    await env.CHARGES_KV.put(CORRECTIONS_KV_KEY, JSON.stringify(merged));
    return new Response(
      JSON.stringify({ saved: count, total: Object.keys(merged).length }),
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } },
    );
  }

  if (request.method === "DELETE") {
    // Accepts either no body (clear all) or { chargeKey: "..." } (remove one)
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch {}
    if (body && body.chargeKey) {
      const existing = (await env.CHARGES_KV.get(CORRECTIONS_KV_KEY, { type: "json" })) || {};
      delete existing[body.chargeKey];
      await env.CHARGES_KV.put(CORRECTIONS_KV_KEY, JSON.stringify(existing));
      return new Response(JSON.stringify({ removed: 1, total: Object.keys(existing).length }),
        { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }
    await env.CHARGES_KV.delete(CORRECTIONS_KV_KEY);
    return new Response(JSON.stringify({ cleared: true }),
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
}

// ---- BigQuery sync (via published Google Sheet) ----
// BC -> BigQuery -> Connected Sheet (publishes as CSV) -> this Worker -> revenue_v1 KV.
// The Sheet URL is configured via env.BQ_SHEET_URL (wrangler.jsonc).
//
// Behaviour: additive with dedup (same recordKey as POST /api/revenue). If the BC->BQ
// pipeline is down, manually-uploaded CSV rows still survive — they share the dedup key
// space so re-running sync after manual upload is idempotent.

// Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes (""), CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      field += c;
    } else {
      if (c === '"') { inQuotes = true; continue; }
      if (c === ",") { row.push(field); field = ""; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
      if (c === "\r") { continue; } // skip CR (CRLF handling)
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Map one BQ-view row (object keyed by snake_case BQ columns) to the revenueRecord
// shape used by the dashboard. Keep field names aligned with the existing /api/revenue
// store schema so the dedup key continues to match across manual-CSV and BQ-sync sources.
function bqRowToRevenue(r) {
  const postingDate = r.posting_date || "";
  const month = postingDate.length >= 7 ? postingDate.substring(0, 7) : "";
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    documentNo: r.document_no || "",
    lineNo: r.line_no !== "" && r.line_no != null ? Number(r.line_no) : null,
    orderNo: r.order_no || "",
    postingDate,
    shipmentDate: "",
    month,
    customerNo: r.sell_to_customer_no || "",
    customerName: (r.sell_to_customer_name || "").trim(),
    type: r.type || "",
    itemNo: r.no || "",
    description: r.description || "",
    quantity: num(r.quantity),
    unitPrice: num(r.unit_price),
    amount: num(r.amount),
    discountPct: num(r.line_discount_percent),
    currency: (r.currency_code || "").trim() || "GBP",
    source: "bq",
  };
}

async function syncFromBq(env) {
  const url = env.BQ_SHEET_URL;
  if (!url) {
    return { ok: false, error: "BQ_SHEET_URL not configured" };
  }
  const t0 = Date.now();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    return { ok: false, error: `Fetch ${res.status} ${res.statusText}` };
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows.length) {
    return { ok: false, error: "Empty CSV" };
  }
  const header = rows[0].map(h => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue; // blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] != null ? rows[r][c] : "";
    records.push(bqRowToRevenue(obj));
  }

  // Additive merge using the existing REVENUE_CONFIG.recordKey.
  const existing = (await env.CHARGES_KV.get(REVENUE_CONFIG.kvKey, { type: "json" })) || [];
  const seen = new Set(existing.map(REVENUE_CONFIG.recordKey));
  const fresh = [];
  for (const r of records) {
    const k = REVENUE_CONFIG.recordKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      fresh.push(r);
    }
  }
  const merged = existing.concat(fresh);
  await env.CHARGES_KV.put(REVENUE_CONFIG.kvKey, JSON.stringify(merged));
  await env.CHARGES_KV.put("bq_synced_at", new Date().toISOString());

  // Diagnostics for the response: oldest/newest postingDate seen this sync.
  const dates = records.map(r => r.postingDate).filter(Boolean).sort();
  return {
    ok: true,
    fetched: records.length,
    added: fresh.length,
    deduped: records.length - fresh.length,
    total: merged.length,
    oldest: dates[0] || null,
    newest: dates[dates.length - 1] || null,
    durationMs: Date.now() - t0,
  };
}

async function handleBqSync(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!checkAuth(request, env)) {
    return unauthorized();
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
  }
  // GET = status-only probe (does NOT trigger sync). POST = run the sync.
  if (request.method === "GET") {
    return new Response(JSON.stringify({ ok: true, configured: !!env.BQ_SHEET_URL }),
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  }
  const result = await syncFromBq(env);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// ---- Rate card storage ----
// Stores the parsed UPS rate card (carrier-negotiated rates) as JSON under one KV key.
// Browser does the XML parsing (file is ~860KB, Worker-safe but cleaner client-side),
// then POSTs the parsed structure here for shared storage so every dashboard viewer
// sees the same rates. GET retrieves, POST replaces, DELETE clears.

const RATE_CARD_KV_KEY = "rate_card_v1";

async function handleRateCard(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!checkAuth(request, env)) return unauthorized();

  if (request.method === "GET") {
    const data = await env.CHARGES_KV.get(RATE_CARD_KV_KEY, { type: "json" });
    return new Response(JSON.stringify(data || null), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return new Response("Bad JSON", { status: 400, headers: corsHeaders() }); }
    // Sanity check — must look like our parsed structure
    if (!body || typeof body !== "object" || !body.services) {
      return new Response("Expected { services: {...}, ...metadata }", { status: 400, headers: corsHeaders() });
    }
    // Stamp upload metadata server-side so we know when it landed (vs whatever the
    // client may have set in body.uploadedAt — keep their value if they set it).
    if (!body.uploadedAt) body.uploadedAt = new Date().toISOString();
    body.uploadedBy = request.headers.get("CF-Connecting-IP") || "anon";
    await env.CHARGES_KV.put(RATE_CARD_KV_KEY, JSON.stringify(body));
    return new Response(JSON.stringify({
      stored: true,
      services: Object.keys(body.services).length,
      uploadedAt: body.uploadedAt,
    }), { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
  }

  if (request.method === "DELETE") {
    await env.CHARGES_KV.delete(RATE_CARD_KV_KEY);
    return new Response(JSON.stringify({ cleared: true }), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
}

// ---- VLE (Vendor Ledger Entries) sync ----
// Pulls BC Vendor Ledger Entries via the published-as-CSV Google Sheet tab,
// normalizes column names (snake_case -> camelCase), normalizes signs (BC posts
// vendor invoices as negative; we want positive amounts), and REPLACES the KV
// store (not additive — ledger state changes when invoices get paid; we want
// the current snapshot, not historical accumulation).
//
// KV key: vendor_ledger_v1
// Source: env.VLE_SHEET_URL (set in wrangler.jsonc)
//
// Response shape consumed by the dashboard:
//   { ok, records: [...], stored, amountDue, amountOverdue, fetched, durationMs }

const VLE_KV_KEY = "vendor_ledger_v1";

function vleRowToRecord(r) {
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const postingDate = (r.posting_date || "").trim();
  const month = postingDate.length >= 7 ? postingDate.substring(0, 7) : "";
  // BC posts vendor invoices as negative. Dashboard expects positive.
  const originalAmount = Math.abs(num(r.original_amt_lcy));
  const remainingAmount = Math.abs(num(r.remaining_amt_lcy));
  const amount = Math.abs(num(r.amount_lcy));
  // "open" comes as the string "TRUE" / "FALSE" from BC.
  const openStr = (r.open || "").toString().trim().toUpperCase();
  const open = openStr === "TRUE" || openStr === "1";
  return {
    vendorNo: (r.vendor_no || "").trim(),
    vendorName: (r.vendor_name || "").trim(),
    documentNo: (r.document_no || "").trim(),
    externalDocumentNo: (r.external_document_no || "").trim(),
    documentType: (r.document_type || "").trim(),
    postingDate,
    month,
    dueDate: (r.due_date || "").trim(),
    documentDate: (r.document_date || "").trim(),
    closedAtDate: (r.closed_at_date || "").trim(),
    originalAmount,
    remainingAmount,
    amount,
    open,
    currency: (r.currency_code || "").trim() || "GBP",
    description: (r.description || "").trim(),
    paymentMethod: (r.payment_method_code || "").trim(),
  };
}

async function syncFromVle(env) {
  const url = env.VLE_SHEET_URL;
  if (!url) {
    return { ok: false, error: "VLE_SHEET_URL not configured" };
  }
  const t0 = Date.now();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    return { ok: false, error: `Fetch ${res.status} ${res.statusText}` };
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (!rows.length) {
    return { ok: false, error: "Empty CSV" };
  }
  const header = rows[0].map(h => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = rows[r][c] != null ? rows[r][c] : "";
    }
    records.push(vleRowToRecord(obj));
  }

  // REPLACE (not additive) — ledger state changes as invoices get paid.
  await env.CHARGES_KV.put(VLE_KV_KEY, JSON.stringify(records));
  await env.CHARGES_KV.put("vle_synced_at", new Date().toISOString());

  // Compute summary numbers the dashboard's "VLE: X entries, £Y due / £Z overdue" line uses.
  const today = new Date().toISOString().substring(0, 10);
  let amountDue = 0, amountOverdue = 0;
  for (const r of records) {
    if (!r.open || r.documentType !== "Invoice") continue;
    if (r.dueDate && r.dueDate < today) amountOverdue += r.remainingAmount;
    else amountDue += r.remainingAmount;
  }

  return {
    ok: true,
    fetched: records.length,
    stored: records.length,
    amountDue: Math.round(amountDue * 100) / 100,
    amountOverdue: Math.round(amountOverdue * 100) / 100,
    durationMs: Date.now() - t0,
    records,
  };
}

async function handleVleSync(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!checkAuth(request, env)) return unauthorized();
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
  }
  // GET = read current snapshot from KV (does NOT trigger a sync). POST = sync from sheet.
  if (request.method === "GET") {
    const records = (await env.CHARGES_KV.get(VLE_KV_KEY, { type: "json" })) || [];
    const bqSyncedAt = await env.CHARGES_KV.get("bq_synced_at");
    const vleSyncedAt = await env.CHARGES_KV.get("vle_synced_at");
    return new Response(JSON.stringify({ ok: true, records, stored: records.length, bqSyncedAt, vleSyncedAt }), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
  const result = await syncFromVle(env);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

