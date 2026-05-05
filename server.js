import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";

const app = express();
app.use(express.json());

const DY_API_URL = "https://dy-api.com/v2/serve/user/assistant";
const DY_API_KEY = process.env.DY_API_KEY;
// Optional: set SITE_BASE_URL in Railway if product URLs are relative (e.g. https://www.mystore.com)
const SITE_BASE_URL = (
  process.env.SITE_BASE_URL || "https://se-demo-retail.use1.dev.pub.dydy.io"
).replace(/\/$/, "");

function toAbsoluteUrl(rawUrl, baseUrl = "") {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    return new URL(rawUrl, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRuntimeBaseUrl(req) {
  const host = req.get("host") || "";
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const runtimeBaseUrl = host ? `${protocol}://${host}` : "";
  return runtimeBaseUrl.replace(/\/$/, "");
}

// Precisely extract products from the DY Shopping Muse response shape:
// choices[0].variations[0].payload.data.widgets[].slots[].productData
function extractFromDYResponse(data) {
  const variation = data?.choices?.[0]?.variations?.[0];
  const dyData = variation?.payload?.data ?? {};
  const assistantText = dyData.assistant ?? "";
  const widgets = dyData.widgets ?? [];

  const groups = widgets.map((widget) => {
    const products = (widget.slots ?? []).map((slot) => {
      const p = slot.productData ?? {};
      const rawUrl = p.url ?? slot.url ?? slot.link ?? null;
      const rawImage = p.image_url ?? slot.image ?? null;
      const url = toAbsoluteUrl(rawUrl, SITE_BASE_URL);
      const image = toAbsoluteUrl(rawImage, SITE_BASE_URL);
      return {
        sku: slot.sku ?? null,
        name: p.name ?? null,
        brand: p.brand ?? null,
        color: p.color ?? null,
        price: typeof p.price === "number" ? p.price : null,
        url,
        image,
        inStock: p.in_stock ?? true,
      };
    });
    return { title: widget.title ?? "", products };
  });

  return { assistantText, groups };
}

app.all("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "shopping-muse",
    version: "1.0.0",
  });

  server.tool(
    "shopping_muse_search",
    "Search for fashion and retail products using Dynamic Yield's Shopping Muse AI assistant. Use this to answer natural language shopping queries like 'summer office dresses' or 'casual trainers under £100'. IMPORTANT: Present results as visual markdown product cards (image plus clickable product link) and do not replace them with a prose summary.",
    {
      query: z.string().describe("Natural language shopping query from the user"),
      dyid: z.string().optional().describe("Dynamic Yield user ID for personalisation (optional)"),
      locale: z.string().optional().describe("Locale code e.g. en_GB, en_US (default: en_US)"),
    },
    async ({ query, dyid = "anonymous-user", locale = "en_US" }) => {
      if (!DY_API_KEY) {
        return {
          content: [{ type: "text", text: "Error: DY_API_KEY environment variable is not set." }],
          isError: true,
        };
      }

      const payload = {
        query: { text: query },
        user: {
          active_consent_accepted: true,
          dyid,
        },
        session: {
          dy: `session-${Date.now()}`,
        },
        context: {
          page: {
            type: "HOMEPAGE",
            data: [""],
            location: "https://my-site.com",
            locale,
          },
        },
        selector: {
          name: "Shopping Muse",
        },
        options: {
          returnAnalyticsMetadata: false,
          isImplicitClientData: false,
          isImplicitKeywordSearchEvent: false,
        },
      };

      let data;
      try {
        const response = await fetch(DY_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "DY-API-Key": DY_API_KEY,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{ type: "text", text: `DY API error ${response.status}: ${errorText}` }],
            isError: true,
          };
        }

        data = await response.json();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Network error: ${err.message}` }],
          isError: true,
        };
      }

      const { assistantText, groups } = extractFromDYResponse(data);
      const totalProducts = groups.reduce((n, g) => n + g.products.length, 0);
      const baseUrl = buildRuntimeBaseUrl(req);

      const normalizedProducts = groups.flatMap((group) =>
        (group.products || []).map((p) => {
          const proxiedImage = p.image
            ? baseUrl
              ? `${baseUrl}/img-proxy?url=${encodeURIComponent(p.image)}`
              : p.image
            : null;
          return {
            groupTitle: group.title || "",
            sku: p.sku || null,
            brand: p.brand || "",
            name: p.name || "Product",
            color: p.color || "",
            price: p.price,
            url: p.url || null,
            image: proxiedImage,
            inStock: p.inStock,
          };
        })
      );

      const markdownCards = normalizedProducts.slice(0, 12).flatMap((p) => {
        const price = p.price !== null ? `GBP ${Number(p.price).toFixed(2)}` : "Price unavailable";
        const heading = `**${[p.brand, p.name].filter(Boolean).join(" ")}** (${price})`;
        const lines = [heading];
        if (p.image) lines.push(`![Product image](<${p.image}>)`);
        lines.push(p.url ? `[View product](<${p.url}>)` : "Link unavailable");
        lines.push("");
        return lines;
      });

      const markdownCardsText = markdownCards.join("\n").trim();
      const feedText = markdownCardsText
        ? `SHOW THESE PRODUCT CARDS EXACTLY AS WRITTEN:\n\n${markdownCardsText}`
        : "No products were returned for this query.";

      return {
        structuredContent: {
          assistantText,
          totalProducts,
          products: normalizedProducts,
          renderHint: "visual_cards",
        },
        content: [
          {
            type: "text",
            text: `${assistantText}\n\n${feedText}`,
          },
        ],
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Proxies product images through this domain to avoid client-side host allowlist blocks
app.get("/img-proxy", async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw || typeof raw !== "string") {
      res.status(400).send("Missing url query param");
      return;
    }

    let target;
    try {
      target = new URL(raw);
    } catch {
      target = new URL(raw, SITE_BASE_URL);
    }
    if (!/^https?:$/.test(target.protocol)) {
      res.status(400).send("Invalid url protocol");
      return;
    }
    if (["localhost", "127.0.0.1", "::1"].includes(target.hostname)) {
      res.status(400).send("Blocked host");
      return;
    }

    const upstream = await fetch(target.toString(), { redirect: "follow" });
    if (!upstream.ok) {
      res.status(502).send(`Image fetch failed: ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// Product recommendation widget — renders grouped product cards
app.get("/widget", (req, res) => {
  let groups = [];
  try {
    const raw = Buffer.from(req.query.data || "", "base64url").toString("utf8");
    groups = JSON.parse(raw).groups ?? [];
  } catch {
    // fall through to empty state
  }

  const sectionsHtml = groups
    .map((group) => {
      const cards = (group.products ?? [])
        .map((p) => {
          const baseUrl = buildRuntimeBaseUrl(req);
          const proxiedImage = p.image
            ? baseUrl
              ? `${baseUrl}/img-proxy?url=${encodeURIComponent(p.image)}`
              : p.image
            : null;
          const img = p.image
            ? `<img src="${escapeHtml(proxiedImage)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
            : "";
          const imgFallback = `<div class="img-placeholder" style="display:${p.image ? "none" : "flex"}">🛍️</div>`;
          const brand = p.brand ? `<div class="brand">${escapeHtml(p.brand)}</div>` : "";
          const color = p.color ? `<div class="color">${escapeHtml(p.color)}</div>` : "";
          const price = p.price !== null ? `<div class="price">£${Number(p.price).toFixed(2)}</div>` : "";
          const link = p.url
            ? `<a class="btn" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">View product →</a>`
            : "";
          return `<div class="card">${img}${imgFallback}<div class="card-body">${brand}<div class="name">${escapeHtml(p.name)}</div>${color}${price}${link}</div></div>`;
        })
        .join("");
      const title = group.title ? `<h2>${escapeHtml(group.title)}</h2>` : "";
      return `<section>${title}<div class="grid">${cards}</div></section>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopping Muse</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;padding:20px;color:#111}
  section{margin-bottom:32px}
  h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:14px}
  .card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07);display:flex;flex-direction:column;transition:box-shadow .2s,transform .2s}
  .card:hover{box-shadow:0 6px 18px rgba(0,0,0,.12);transform:translateY(-2px)}
  .card img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;background:#f8f8f8}
  .img-placeholder{width:100%;aspect-ratio:4/5;background:#f0f0f0;align-items:center;justify-content:center;font-size:3rem}
  .card-body{padding:10px 12px 12px;display:flex;flex-direction:column;flex:1;gap:3px}
  .brand{font-size:10px;font-weight:700;color:#bbb;text-transform:uppercase;letter-spacing:.06em}
  .name{font-size:13px;font-weight:500;color:#222;flex:1;line-height:1.35;margin-top:2px}
  .color{font-size:11px;color:#aaa;margin-top:1px}
  .price{font-size:15px;font-weight:700;color:#111;margin-top:4px}
  .btn{display:block;margin-top:10px;padding:9px 10px;background:#111;color:#fff;text-decoration:none;border-radius:8px;text-align:center;font-size:12px;font-weight:600;letter-spacing:.02em;transition:background .15s}
  .btn:hover{background:#444}
  .empty{text-align:center;color:#bbb;padding:60px;font-size:14px}
</style>
</head>
<body>
  ${sectionsHtml || '<div class="empty">No products found.</div>'}
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.send(html);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "shopping-muse-mcp" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopping Muse MCP server running on port ${PORT}`);
});
