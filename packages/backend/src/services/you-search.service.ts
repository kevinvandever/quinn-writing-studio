/**
 * You.com Search Service
 *
 * Wraps the You.com Search API (https://ydc-index.io/v1/search) for use as
 * an intelligence source. Returns structured web + news results with snippets.
 *
 * Requires the YOU_API_KEY environment variable. If it's not set, callers
 * should skip you.com-based sources gracefully.
 *
 * Pricing: ~$5 per 1,000 calls. Docs: https://you.com/docs/guides/search
 */

import { config } from '../config.js';

const YOU_SEARCH_ENDPOINT = 'https://ydc-index.io/v1/search';

export interface YouSearchResult {
  title: string;
  url: string;
  description: string;
  snippets: string[];
  pageAge: string | null;
}

export interface YouSearchOptions {
  /** Max results to return (default 10) */
  count?: number;
  /** Recency filter: 'day' | 'week' | 'month' | 'year' */
  freshness?: 'day' | 'week' | 'month' | 'year';
  /** Restrict results to these domains */
  includeDomains?: string[];
}

interface YouApiResponse {
  results?: {
    web?: Array<{
      url?: string;
      title?: string;
      description?: string;
      snippets?: string[];
      page_age?: string;
    }>;
    news?: Array<{
      url?: string;
      title?: string;
      description?: string;
      page_age?: string;
    }>;
  };
}

/**
 * Whether the you.com integration is configured.
 */
export function isYouSearchEnabled(): boolean {
  return Boolean(config.YOU_API_KEY);
}

/**
 * Run a search against the You.com Search API.
 * Returns a flat list of web + news results, or an empty array if the
 * API key is missing or the request fails.
 */
export async function youSearch(
  query: string,
  options: YouSearchOptions = {}
): Promise<YouSearchResult[]> {
  if (!config.YOU_API_KEY) {
    console.warn('[YouSearch] YOU_API_KEY not set — skipping you.com search');
    return [];
  }

  const { count = 10, freshness, includeDomains } = options;

  const body: Record<string, unknown> = { query, count };
  if (freshness) body['freshness'] = freshness;
  if (includeDomains && includeDomains.length > 0) body['include_domains'] = includeDomains;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(YOU_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-Key': config.YOU_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[YouSearch] API error (${response.status}): ${text.slice(0, 200)}`);
      return [];
    }

    const data = (await response.json()) as YouApiResponse;
    const results: YouSearchResult[] = [];

    for (const web of data.results?.web ?? []) {
      if (!web.title || !web.url) continue;
      results.push({
        title: web.title,
        url: web.url,
        description: web.description ?? '',
        snippets: web.snippets ?? [],
        pageAge: web.page_age ?? null,
      });
    }

    for (const news of data.results?.news ?? []) {
      if (!news.title || !news.url) continue;
      results.push({
        title: news.title,
        url: news.url,
        description: news.description ?? '',
        snippets: [],
        pageAge: news.page_age ?? null,
      });
    }

    return results;
  } catch (err) {
    console.error('[YouSearch] Request failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
