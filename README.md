# Shopping Muse MCP Server

An MCP (Model Context Protocol) server that wraps the Dynamic Yield Shopping Muse API, allowing Claude to answer natural language shopping queries.

## Tools exposed

| Tool | Description |
|------|-------------|
| `shopping_muse_search` | Accepts a natural language query and returns Shopping Muse product recommendations from Dynamic Yield |

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new project in [Railway](https://railway.app) → **Deploy from GitHub repo**
3. In the Railway project, go to **Variables** and add:
   ```
   DY_API_KEY=your_key_here
   ```
4. Railway will auto-detect the `railway.json` and start the server
5. Go to **Settings → Networking → Generate Domain** to get your public HTTPS URL

## Connect to Claude.ai

1. Go to **Claude.ai → Settings → Connectors → Add custom connector**
2. Enter your Railway URL: `https://your-app.railway.app/mcp`
3. Claude will automatically discover the `shopping_muse_search` tool

## Local development

```bash
cp .env.example .env
# Edit .env and add your real DY_API_KEY

npm install
npm run dev
```

Server runs on `http://localhost:3000`. Test with:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
