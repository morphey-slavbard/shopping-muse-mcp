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

function formatProductsForText(products) {
  if (!products.length) {
    return null;
  }

  const lines = ["Top product matches:"];
  for (const [index, product] of products.slice(0, 12).entries()) {
    const priceText = product.price !== null ? ` - ${product.price.toFixed(2)}${product.currency ? ` ${product.currency}` : ""}` : "";
    const brandText = product.brand ? `${product.brand} ` : "";
    const linkText = product.url ? ` (${product.url})` : "";
    lines.push(`${index + 1}. ${brandText}${product.name}${priceText}${linkText}`);
  }

  return lines.join("\n");
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
      const formattedProducts = formatProductsForText(products);

      return {
        structuredContent: {
          products,
          totalProducts: products.length,
        },
        content: [
          {
            type: "text",
            text: formattedProducts || JSON.stringify(data, null, 2),
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

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "shopping-muse-mcp" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopping Muse MCP server running on port ${PORT}`);
});
