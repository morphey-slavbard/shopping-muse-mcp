import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";

const app = express();
app.use(express.json());

const DY_API_URL = "https://dy-api.com/v2/serve/user/assistant";
const DY_API_KEY = process.env.DY_API_KEY;

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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
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
