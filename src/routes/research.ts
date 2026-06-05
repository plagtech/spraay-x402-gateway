/**
 * 💧 Spraay Gateway — Research & Reference Endpoints
 * Category: Research & Reference
 *
 * Upstream sources (all free, commercially licensed):
 *   - Free Dictionary API (CC0-equivalent, no key)
 *   - OpenAlex (CC0, API key for $1/day free usage)
 *   - arXiv (CC0 metadata, no key)
 *   - Crossref (CC0 metadata, no key — email for polite pool)
 *   - PubChem / NCBI (US Gov public domain, free NCBI key)
 *   - PubMed / NCBI E-utilities (US Gov public domain, free NCBI key)
 *   - US Census Bureau (US Gov public domain, free key)
 *
 * ENV VARS:
 *   OPENALEX_API_KEY   — from https://openalex.org/settings/api
 *   NCBI_API_KEY       — from https://www.ncbi.nlm.nih.gov/account/settings/
 *   NCBI_EMAIL         — contact email for NCBI E-utilities
 *   CENSUS_API_KEY     — from https://api.census.gov/data/key_signup.html
 *   CROSSREF_EMAIL     — email for Crossref polite pool (optional)
 */

import { Request, Response } from "express";

// ─── Config ─────────────────────────────────────────────────────────────────

const OPENALEX_API_KEY = process.env.OPENALEX_API_KEY || "";
const NCBI_API_KEY = process.env.NCBI_API_KEY || "";
const NCBI_TOOL = "spraay-gateway";
const NCBI_EMAIL = process.env.NCBI_EMAIL || "hello@spraay.app";
const CENSUS_API_KEY = process.env.CENSUS_API_KEY || "";
const CROSSREF_EMAIL = process.env.CROSSREF_EMAIL || "hello@spraay.app";

// ─── Helpers ────────────────────────────────────────────────────────────────

function envelope(
  endpoint: string,
  source: string,
  license: string,
  data: any,
  extra: Record<string, any> = {}
) {
  return {
    category: "research",
    endpoint,
    source,
    source_license: license,
    ...extra,
    results: Array.isArray(data) ? data : data == null ? [] : [data],
    attribution: attributionFor(source),
    spraay_request_id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function attributionFor(source: string): string {
  const map: Record<string, string> = {
    openalex: "Data from OpenAlex (https://openalex.org). Licensed under CC0.",
    arxiv: "Thank you to arXiv for use of its open access interoperability. Metadata licensed under CC0.",
    crossref: "Data from Crossref (https://www.crossref.org). Bibliographic metadata is CC0.",
    pubchem: "Data from PubChem (https://pubchem.ncbi.nlm.nih.gov), National Library of Medicine, NIH.",
    pubmed: "Data from PubMed (https://pubmed.ncbi.nlm.nih.gov), National Library of Medicine, NIH.",
    freedict: "Data from Free Dictionary API (https://dictionaryapi.dev).",
    census: "Data from U.S. Census Bureau (https://www.census.gov).",
    datagov: "Data from Data.gov (https://data.gov), U.S. General Services Administration.",
  };
  return map[source] || "";
}

async function safeFetch(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
  return res.json();
}

async function safeFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Upstream ${res.status}: ${res.statusText}`);
  return res.text();
}

/** Build OpenAlex URL with api_key */
function oaUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://api.openalex.org${path}`);
  if (OPENALEX_API_KEY) url.searchParams.set("api_key", OPENALEX_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Build NCBI E-utilities URL with api_key + tool + email */
function ncbiUrl(endpoint: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${endpoint}`);
  url.searchParams.set("tool", NCBI_TOOL);
  url.searchParams.set("email", NCBI_EMAIL);
  if (NCBI_API_KEY) url.searchParams.set("api_key", NCBI_API_KEY);
  url.searchParams.set("retmode", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Build Crossref URL with polite-pool mailto */
function crUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://api.crossref.org${path}`);
  if (CROSSREF_EMAIL) url.searchParams.set("mailto", CROSSREF_EMAIL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. DICTIONARY & LANGUAGE  (Free Dictionary API — no key, no limits)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchDictDefineHandler(req: Request, res: Response) {
  try {
    const word = req.query.word as string;
    const lang = (req.query.lang as string) || "en";
    if (!word) return res.status(400).json({ error: "missing_param", message: "Query param 'word' is required." });

    const data = await safeFetch(
      `https://api.dictionaryapi.dev/api/v2/entries/${encodeURIComponent(lang)}/${encodeURIComponent(word)}`
    );
    res.json(envelope("dictionary/define", "freedict", "free/open", data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchDictSynonymsHandler(req: Request, res: Response) {
  try {
    const word = req.query.word as string;
    if (!word) return res.status(400).json({ error: "missing_param", message: "Query param 'word' is required." });

    const data = await safeFetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    const synonyms: string[] = [];
    const antonyms: string[] = [];
    for (const entry of data) {
      for (const meaning of entry.meanings || []) {
        synonyms.push(...(meaning.synonyms || []));
        antonyms.push(...(meaning.antonyms || []));
        for (const def of meaning.definitions || []) {
          synonyms.push(...(def.synonyms || []));
          antonyms.push(...(def.antonyms || []));
        }
      }
    }
    res.json(envelope("dictionary/synonyms", "freedict", "free/open", {
      word,
      synonyms: [...new Set(synonyms)],
      antonyms: [...new Set(antonyms)],
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchDictPhoneticsHandler(req: Request, res: Response) {
  try {
    const word = req.query.word as string;
    if (!word) return res.status(400).json({ error: "missing_param", message: "Query param 'word' is required." });

    const data = await safeFetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
    );
    const phonetics = data.flatMap((e: any) => e.phonetics || []).filter((p: any) => p.text || p.audio);
    res.json(envelope("dictionary/phonetics", "freedict", "free/open", { word, phonetics }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. ACADEMIC PAPERS  (OpenAlex — CC0, api_key auth, $1/day free)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchPapersSearchHandler(req: Request, res: Response) {
  try {
    const q = req.query.q as string;
    const page = (req.query.page as string) || "1";
    const perPage = (req.query.per_page as string) || "10";
    const filter = req.query.filter as string;
    const select = req.query.select as string;
    if (!q) return res.status(400).json({ error: "missing_param", message: "Query param 'q' is required." });

    const params: Record<string, string> = { search: q, page, per_page: perPage };
    if (filter) params.filter = filter;
    if (select) params.select = select;

    const data = await safeFetch(oaUrl("/works", params));
    res.json(envelope("papers/search", "openalex", "CC0", data.results || [], {
      total_results: data.meta?.count || 0,
      page: Number(page),
      per_page: Number(perPage),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPapersByDoiHandler(req: Request, res: Response) {
  try {
    const doi = req.query.doi as string;
    if (!doi) return res.status(400).json({ error: "missing_param", message: "Query param 'doi' is required." });

    const data = await safeFetch(oaUrl(`/works/doi:${doi}`));
    res.json(envelope("papers/by-doi", "openalex", "CC0", data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPapersByAuthorHandler(req: Request, res: Response) {
  try {
    const author = req.query.author as string;
    const orcid = req.query.orcid as string;
    const page = (req.query.page as string) || "1";
    const perPage = (req.query.per_page as string) || "10";
    if (!author && !orcid) return res.status(400).json({ error: "missing_param", message: "Query param 'author' or 'orcid' is required." });

    let filter: string;
    if (orcid) {
      filter = `author.orcid:${orcid}`;
    } else {
      // Two-step: search authors first, then use ID
      // For convenience, use authorships filter with search
      filter = `authorships.author.id:*`; // fallback
      // Better: use search param with author filter
      const authorSearch = await safeFetch(oaUrl("/authors", { search: author!, per_page: "1" }));
      const authorId = authorSearch.results?.[0]?.id;
      if (authorId) {
        filter = `authorships.author.id:${authorId.replace("https://openalex.org/", "")}`;
      } else {
        return res.status(404).json({ error: "author_not_found", message: `No author found for '${author}'.` });
      }
    }

    const data = await safeFetch(oaUrl("/works", { filter, page, per_page: perPage }));
    res.json(envelope("papers/by-author", "openalex", "CC0", data.results || [], {
      total_results: data.meta?.count || 0,
      page: Number(page),
      per_page: Number(perPage),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPapersCitationsHandler(req: Request, res: Response) {
  try {
    const doi = req.query.doi as string;
    const openalexId = req.query.id as string;
    if (!doi && !openalexId) return res.status(400).json({ error: "missing_param", message: "Query param 'doi' or 'id' is required." });

    const workPath = doi ? `/works/doi:${doi}` : `/works/${openalexId}`;
    const data = await safeFetch(oaUrl(workPath, {
      select: "id,title,doi,cited_by_count,cited_by_api_url,referenced_works,referenced_works_count",
    }));
    res.json(envelope("papers/citations", "openalex", "CC0", {
      id: data.id,
      title: data.title,
      doi: data.doi,
      cited_by_count: data.cited_by_count,
      cited_by_api_url: data.cited_by_api_url,
      referenced_works: data.referenced_works,
      referenced_works_count: data.referenced_works_count,
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPapersTrendingHandler(req: Request, res: Response) {
  try {
    const topic = (req.query.topic as string) || "";
    const days = (req.query.days as string) || "7";
    const perPage = (req.query.per_page as string) || "10";

    const fromDate = new Date(Date.now() - Number(days) * 86400000).toISOString().slice(0, 10);
    const params: Record<string, string> = {
      filter: `from_publication_date:${fromDate}`,
      sort: "cited_by_count:desc",
      per_page: perPage,
    };
    if (topic) params.search = topic;

    const data = await safeFetch(oaUrl("/works", params));
    res.json(envelope("papers/trending", "openalex", "CC0", data.results || [], {
      total_results: data.meta?.count || 0,
      days_back: Number(days),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. PREPRINTS  (arXiv — CC0 metadata, no key, 1 req/3s)
// ═════════════════════════════════════════════════════════════════════════════

function parseArxivAtom(xml: string): any[] {
  const entries: any[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : "";
    };
    const getAll = (tag: string) => {
      const results: string[] = [];
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
      let m2;
      while ((m2 = r.exec(block)) !== null) results.push(m2[1].trim());
      return results;
    };
    const getAttr = (tag: string, attr: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>`, "g"));
      return m
        ? m.map((el: string) => { const a = el.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; }).filter(Boolean)
        : [];
    };

    entries.push({
      id: get("id"),
      title: get("title").replace(/\s+/g, " "),
      summary: get("summary").replace(/\s+/g, " "),
      authors: getAll("name"),
      published: get("published"),
      updated: get("updated"),
      categories: getAttr("category", "term"),
      pdf_link: get("id").replace("/abs/", "/pdf/"),
    });
  }
  return entries;
}

export async function researchPreprintsSearchHandler(req: Request, res: Response) {
  try {
    const q = req.query.q as string;
    const category = req.query.category as string;
    const maxResults = (req.query.max_results as string) || "10";
    if (!q && !category) return res.status(400).json({ error: "missing_param", message: "Query param 'q' or 'category' is required." });

    let searchQuery = "";
    if (q) searchQuery += `all:${q}`;
    if (category) searchQuery += (searchQuery ? "+AND+" : "") + `cat:${category}`;

    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(searchQuery)}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await safeFetchText(url);
    const entries = parseArxivAtom(xml);

    res.json(envelope("preprints/search", "arxiv", "CC0", entries, { total_results: entries.length }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPreprintsByIdHandler(req: Request, res: Response) {
  try {
    const arxivId = req.query.id as string;
    if (!arxivId) return res.status(400).json({ error: "missing_param", message: "Query param 'id' is required (e.g. '2301.00001')." });

    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
    const xml = await safeFetchText(url);
    const entries = parseArxivAtom(xml);

    res.json(envelope("preprints/by-id", "arxiv", "CC0", entries[0] || null));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchPreprintsRecentHandler(req: Request, res: Response) {
  try {
    const category = (req.query.category as string) || "cs.AI";
    const maxResults = (req.query.max_results as string) || "10";

    const url = `https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
    const xml = await safeFetchText(url);
    const entries = parseArxivAtom(xml);

    res.json(envelope("preprints/recent", "arxiv", "CC0", entries, { category, total_results: entries.length }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. SCHOLARLY METADATA  (Crossref — CC0, no key, polite pool via email)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchScholarlyByDoiHandler(req: Request, res: Response) {
  try {
    const doi = req.query.doi as string;
    if (!doi) return res.status(400).json({ error: "missing_param", message: "Query param 'doi' is required." });

    const data = await safeFetch(crUrl(`/works/${encodeURIComponent(doi)}`));
    res.json(envelope("scholarly/by-doi", "crossref", "CC0", data.message || data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchScholarlySearchHandler(req: Request, res: Response) {
  try {
    const q = req.query.q as string;
    const rows = (req.query.rows as string) || "10";
    const offset = (req.query.offset as string) || "0";
    if (!q) return res.status(400).json({ error: "missing_param", message: "Query param 'q' is required." });

    const data = await safeFetch(crUrl("/works", { query: q, rows, offset }));
    res.json(envelope("scholarly/search", "crossref", "CC0", data.message?.items || [], {
      total_results: data.message?.["total-results"] || 0,
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchScholarlyCitationsHandler(req: Request, res: Response) {
  try {
    const doi = req.query.doi as string;
    if (!doi) return res.status(400).json({ error: "missing_param", message: "Query param 'doi' is required." });

    const data = await safeFetch(crUrl(`/works/${encodeURIComponent(doi)}`));
    const msg = data.message || {};
    res.json(envelope("scholarly/citations-count", "crossref", "CC0", {
      doi: msg.DOI,
      title: msg.title?.[0],
      citations_count: msg["is-referenced-by-count"] || 0,
      references_count: msg["references-count"] || 0,
      references: (msg.reference || []).slice(0, 50),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchScholarlyJournalHandler(req: Request, res: Response) {
  try {
    const issn = req.query.issn as string;
    if (!issn) return res.status(400).json({ error: "missing_param", message: "Query param 'issn' is required." });

    const data = await safeFetch(crUrl(`/journals/${encodeURIComponent(issn)}`));
    res.json(envelope("scholarly/journal-info", "crossref", "CC0", data.message || data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. CHEMISTRY & COMPOUNDS  (PubChem — US Gov public domain, no key)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchChemCompoundHandler(req: Request, res: Response) {
  try {
    const name = req.query.name as string;
    const formula = req.query.formula as string;
    const cid = req.query.cid as string;
    if (!name && !formula && !cid) return res.status(400).json({ error: "missing_param", message: "Query param 'name', 'formula', or 'cid' is required." });

    let url: string;
    if (cid) url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${encodeURIComponent(cid)}/JSON`;
    else if (name) url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/JSON`;
    else url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastformula/${encodeURIComponent(formula!)}/JSON`;

    const data = await safeFetch(url);
    res.json(envelope("chemistry/compound", "pubchem", "public-domain", data.PC_Compounds || data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchChemSimilarityHandler(req: Request, res: Response) {
  try {
    const cid = req.query.cid as string;
    const threshold = (req.query.threshold as string) || "90";
    const maxRecords = (req.query.max_records as string) || "10";
    if (!cid) return res.status(400).json({ error: "missing_param", message: "Query param 'cid' is required." });

    const data = await safeFetch(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/fastsimilarity_2d/cid/${encodeURIComponent(cid)}/cids/JSON?Threshold=${threshold}&MaxRecords=${maxRecords}`
    );
    res.json(envelope("chemistry/similarity", "pubchem", "public-domain", data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchChemBioactivityHandler(req: Request, res: Response) {
  try {
    const cid = req.query.cid as string;
    if (!cid) return res.status(400).json({ error: "missing_param", message: "Query param 'cid' is required." });

    const data = await safeFetch(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${encodeURIComponent(cid)}/assaysummary/JSON`
    );
    res.json(envelope("chemistry/bioactivity", "pubchem", "public-domain", data));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. BIOMEDICAL LITERATURE  (PubMed — US Gov, NCBI E-utilities, free key)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchBiomedSearchHandler(req: Request, res: Response) {
  try {
    const q = req.query.q as string;
    const retmax = (req.query.max_results as string) || "10";
    if (!q) return res.status(400).json({ error: "missing_param", message: "Query param 'q' is required." });

    // Step 1: search for PMIDs
    const searchData = await safeFetch(ncbiUrl("esearch.fcgi", { db: "pubmed", term: q, retmax }));
    const ids: string[] = searchData.esearchresult?.idlist || [];
    if (ids.length === 0) return res.json(envelope("biomedical/search", "pubmed", "public-domain", [], { total_results: 0 }));

    // Step 2: fetch summaries
    const summaryData = await safeFetch(ncbiUrl("esummary.fcgi", { db: "pubmed", id: ids.join(",") }));
    const results = ids.map((id) => summaryData.result?.[id]).filter(Boolean);

    res.json(envelope("biomedical/search", "pubmed", "public-domain", results, {
      total_results: Number(searchData.esearchresult?.count || 0),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchBiomedByPmidHandler(req: Request, res: Response) {
  try {
    const pmid = req.query.pmid as string;
    if (!pmid) return res.status(400).json({ error: "missing_param", message: "Query param 'pmid' is required." });

    const data = await safeFetch(ncbiUrl("esummary.fcgi", { db: "pubmed", id: pmid }));
    res.json(envelope("biomedical/by-pmid", "pubmed", "public-domain", data.result?.[pmid] || null));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchBiomedRelatedHandler(req: Request, res: Response) {
  try {
    const pmid = req.query.pmid as string;
    const maxResults = (req.query.max_results as string) || "10";
    if (!pmid) return res.status(400).json({ error: "missing_param", message: "Query param 'pmid' is required." });

    // Step 1: get related IDs
    const linkData = await safeFetch(ncbiUrl("elink.fcgi", { dbfrom: "pubmed", db: "pubmed", id: pmid, cmd: "neighbor_score" }));
    const linkSets = linkData.linksets?.[0]?.linksetdbs?.[0]?.links || [];
    const relatedIds = linkSets.slice(0, Number(maxResults)).map((l: any) => String(l.id || l));

    if (relatedIds.length === 0) return res.json(envelope("biomedical/related", "pubmed", "public-domain", [], { seed_pmid: pmid }));

    // Step 2: fetch summaries
    const summaryData = await safeFetch(ncbiUrl("esummary.fcgi", { db: "pubmed", id: relatedIds.join(",") }));
    const results = relatedIds.map((id: string) => summaryData.result?.[id]).filter(Boolean);

    res.json(envelope("biomedical/related", "pubmed", "public-domain", results, { seed_pmid: pmid }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. DEMOGRAPHICS & GOVERNMENT DATA  (US Census + Data.gov — public domain)
// ═════════════════════════════════════════════════════════════════════════════

export async function researchCensusHandler(req: Request, res: Response) {
  try {
    const dataset = (req.query.dataset as string) || "acs/acs5";
    const year = (req.query.year as string) || "2022";
    const variables = (req.query.variables as string) || "NAME,B01003_001E";
    const geo = (req.query.geo as string) || "state:*";

    const url = new URL(`https://api.census.gov/data/${year}/${dataset}`);
    url.searchParams.set("get", variables);
    url.searchParams.set("for", geo);
    if (CENSUS_API_KEY) url.searchParams.set("key", CENSUS_API_KEY);

    const data = await safeFetch(url.toString());
    // Census returns array-of-arrays; row 0 = headers
    const headers: string[] = data[0];
    const rows = data.slice(1).map((row: string[]) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });

    res.json(envelope("demographics/census", "census", "public-domain", rows, {
      dataset: `${year}/${dataset}`,
      variables: variables.split(","),
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}

export async function researchDatasetsHandler(req: Request, res: Response) {
  try {
    const q = req.query.q as string;
    const rows = (req.query.rows as string) || "10";
    if (!q) return res.status(400).json({ error: "missing_param", message: "Query param 'q' is required." });

    const data = await safeFetch(
      `https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent(q)}&rows=${rows}`
    );
    const results = (data.result?.results || []).map((r: any) => ({
      id: r.id,
      title: r.title,
      notes: r.notes?.slice(0, 300),
      organization: r.organization?.title,
      metadata_modified: r.metadata_modified,
      resources: (r.resources || []).slice(0, 3).map((res: any) => ({
        format: res.format,
        url: res.url,
        name: res.name,
      })),
    }));

    res.json(envelope("demographics/datasets", "datagov", "public-domain", results, {
      total_results: data.result?.count || 0,
    }));
  } catch (err: any) {
    res.status(502).json({ error: "upstream_error", message: err.message });
  }
}
