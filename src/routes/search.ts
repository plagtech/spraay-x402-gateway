// ═══════════════════════════════════════════════════════════════
// search.ts — x402 Search/RAG handlers for Spraay Gateway
// Proxies web search and content extraction through Tavily API.
// Agents get clean, LLM-ready content — not raw HTML.
//
// ENV: TAVILY_API_KEY (required)
//
// Exports:
//   searchWebHandler       POST /api/v1/search/web
//   searchExtractHandler   POST /api/v1/search/extract
//   searchQnaHandler       POST /api/v1/search/qna
// ═══════════════════════════════════════════════════════════════

import { Request, Response } from "express";

const TAVILY_API = "https://api.tavily.com";
const TAVILY_KEY = process.env.TAVILY_API_KEY;

// ── Helpers ─────────────────────────────────────────────────

async function tavilyRequest(path: string, body: any): Promise<any> {
  const resp = await fetch(`${TAVILY_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: TAVILY_KEY, ...body }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Tavily API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

// ── POST /api/v1/search/web ─────────────────────────────────
// General web search — returns clean, LLM-ready results
//
// Body:
//   query: string              — Search query
//   search_depth?: string      — "basic" ($0.01) or "advanced" ($0.02)
//   max_results?: number       — Number of results (default: 5, max: 20)
//   include_domains?: string[] — Only include these domains
//   exclude_domains?: string[] — Exclude these domains
//   topic?: string             — "general" | "news" | "finance"
//
// Returns:
//   { query, results: [{ title, url, content, score }], answer? }
export const searchWebHandler = async (req: Request, res: Response) => {
  try {
    if (!TAVILY_KEY) {
      return res.status(500).json({ error: "Search service not configured (missing TAVILY_API_KEY)" });
    }

    const {
      query,
      search_depth = "basic",
      max_results = 5,
      include_domains,
      exclude_domains,
      topic = "general",
    } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing required field: query (string)" });
    }

    if (!["basic", "advanced"].includes(search_depth)) {
      return res.status(400).json({ error: 'search_depth must be "basic" or "advanced"' });
    }

    const clampedMax = Math.min(Math.max(Number(max_results) || 5, 1), 20);

    const tavilyBody: any = {
      query,
      search_depth,
      max_results: clampedMax,
      topic,
      include_answer: true,
      include_raw_content: false,
    };

    if (include_domains?.length) tavilyBody.include_domains = include_domains;
    if (exclude_domains?.length) tavilyBody.exclude_domains = exclude_domains;

    const data = await tavilyRequest("/search", tavilyBody);

    return res.json({
      query: data.query,
      answer: data.answer || null,
      results: (data.results || []).map((r: any) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        published_date: r.published_date || null,
      })),
      result_count: (data.results || []).length,
      search_depth,
    });
  } catch (err: any) {
    console.error("[search/web]", err.message);
    return res.status(500).json({ error: err.message || "Search request failed" });
  }
};

// ── POST /api/v1/search/extract ─────────────────────────────
// Extract clean content from specific URLs — perfect for RAG
//
// Body:
//   urls: string[]  — URLs to extract content from (max 5)
//
// Returns:
//   { results: [{ url, raw_content, content }], failed: [] }
export const searchExtractHandler = async (req: Request, res: Response) => {
  try {
    if (!TAVILY_KEY) {
      return res.status(500).json({ error: "Search service not configured (missing TAVILY_API_KEY)" });
    }

    const { urls } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Missing required field: urls (array of URL strings)" });
    }

    if (urls.length > 5) {
      return res.status(400).json({ error: "Maximum 5 URLs per extraction request" });
    }

    const data = await tavilyRequest("/extract", { urls });

    return res.json({
      results: (data.results || []).map((r: any) => ({
        url: r.url,
        content: r.raw_content || r.content || "",
      })),
      failed: data.failed_results || [],
    });
  } catch (err: any) {
    console.error("[search/extract]", err.message);
    return res.status(500).json({ error: err.message || "Extract request failed" });
  }
};

// ── POST /api/v1/search/qna ────────────────────────────────
// Direct question answering — searches + synthesizes an answer
//
// Body:
//   query: string          — Natural language question
//   topic?: string         — "general" | "news" | "finance"
//
// Returns:
//   { query, answer, sources: [{ title, url }] }
export const searchQnaHandler = async (req: Request, res: Response) => {
  try {
    if (!TAVILY_KEY) {
      return res.status(500).json({ error: "Search service not configured (missing TAVILY_API_KEY)" });
    }

    const { query, topic = "general" } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Missing required field: query (string)" });
    }

    const data = await tavilyRequest("/search", {
      query,
      search_depth: "advanced",
      max_results: 5,
      topic,
      include_answer: true,
      include_raw_content: false,
    });

    return res.json({
      query: data.query,
      answer: data.answer || "No answer could be generated.",
      sources: (data.results || []).slice(0, 5).map((r: any) => ({
        title: r.title,
        url: r.url,
        score: r.score,
      })),
    });
  } catch (err: any) {
    console.error("[search/qna]", err.message);
    return res.status(500).json({ error: err.message || "Q&A request failed" });
  }
};
