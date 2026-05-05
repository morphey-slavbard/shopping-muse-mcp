import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";

const app = express();
app.use(express.json());

const DY_API_URL = "https://dy-api.com/v2/serve/user/assistant";
const DY_API_KEY = process.env.DY_API_KEY;

function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractProductsFromResponse(payload) {
  const products = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    const name = node.name || node.title || node.productName || node.displayName;
    const brand = node.brand || node.brandName || node.vendor;
    const url = node.url || node.productUrl || node.link || node.href;
    const image = node.image || node.imageUrl || node.thumbnail || node.primaryImage;

    const priceCandidates = [
      node.price,
      node.currentPrice,
      node.salePrice,
      node.priceValue,
      node.amount,
      node.value,
      node?.price?.value,
      node?.price?.amount,
      node?.pricing?.price,
      node?.pricing?.currentPrice,
    ];
    const price = priceCandidates.map(parsePrice).find((candidate) => candidate !== null) ?? null;

    if (typeof name === "string" && name.trim()) {
      const stableKey = `${name}|${url || ""}|${price ?? ""}`;
      if (!seen.has(stableKey)) {
        seen.add(stableKey);
        products.push({
          name: name.trim(),
          brand: typeof brand === "string" ? brand : null,
          price,
          currency: node.currency || node.currencyCode || null,
          url: typeof url === "string" ? url : null,
          image: typeof image === "string" ? image : null,
          category: node.category || node.productType || null,
        });
      }
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(payload);
  return products.slice(0, 24);
}

app.all("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "shopping-muse",
    version: "1.0.0",
  });

  server.tool(
    "shopping_muse_search",
    "Search for fashion and retail products using Dynamic Yield's Shopping Muse AI assistant. Use this to answer natural language shopping queries like 'summer office dresses' or 'casual trainers under £100'.",
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
            content: [
              {
                type: "text",
                text: `DY API error ${response.status}: ${errorText}`,
              },
            ],
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

      const products = extractProductsFromResponse(data);

      // Build widget URL with only the fields needed for display (keeps URL short)
      const widgetPayload = products.map((p) => ({
        name: p.name,
        brand: p.brand,
        price: p.price,
        currency: p.currency,
        url: p.url,
        image: p.image,
      }));
      const widgetData = Buffer.from(JSON.stringify(widgetPayload)).toString("base64url");
      const host = req.get("host");
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const widgetUrl = `${protocol}://${host}/widget?data=${widgetData}`;

      return {
        structuredContent: {
          products,
          totalProducts: products.length,
          widgetUrl,
        },
        content: [
          {
            type: "resource",
            resource: {
              uri: widgetUrl,
              mimeType: "text/html",
            },
          },
          {
            type: "text",
            text: JSON.stringify({ products, totalProducts: products.length }, null, 2),
          },
        ],
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Product recommendation widget
app.get("/widget", (req, res) => {
  let products = [];
  try {
    const raw = Buffer.from(req.query.data || "", "base64url").toString("utf8");
    products = JSON.parse(raw);
  } catch {
    // return empty widget on bad data
  }

  const cards = products
    .map((p) => {
      const img = p.image
        ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : "";
      const imgFallback = `<div class="img-placeholder" style="display:${p.image ? "none" : "flex"}">🛍️</div>`;
      const brand = p.brand ? `<div class="brand">${escapeHtml(p.brand)}</div>` : "";
      const price =
        p.price !== null
          ? `<div class="price">${p.currency ? escapeHtml(p.currency) + " " : ""}${Number(p.price).toFixed(2)}</div>`
          : "";
      const link = p.url
        ? `<a class="btn" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">View product</a>`
        : "";
      return `<div class="card">${img}${imgFallback}${brand}<div class="name">${escapeHtml(p.name)}</div>${price}${link}</div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopping Muse results</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f8f8;padding:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
  .card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);display:flex;flex-direction:column}
  .card img{width:100%;aspect-ratio:1;object-fit:cover}
  .img-placeholder{width:100%;aspect-ratio:1;background:#f0f0f0;align-items:center;justify-content:center;font-size:2.5rem}
  .card .brand{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;padding:10px 10px 0}
  .card .name{font-size:13px;font-weight:500;color:#222;padding:6px 10px;flex:1}
  .card .price{font-size:14px;font-weight:700;color:#111;padding:0 10px 8px}
  .card .btn{display:block;margin:0 10px 10px;padding:8px;background:#111;color:#fff;text-decoration:none;border-radius:6px;text-align:center;font-size:12px;font-weight:600;transition:background .2s}
  .card .btn:hover{background:#333}
  .empty{text-align:center;color:#aaa;padding:40px;font-size:14px}
</style>
</head>
<body>
  ${cards ? `<div class="grid">${cards}</div>` : '<div class="empty">No products found.</div>'}
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "ALLOWALL");
  res.send(html);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "shopping-muse-mcp" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopping Muse MCP server running on port ${PORT}`);
});
