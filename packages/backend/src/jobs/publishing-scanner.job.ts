import RssParser from 'rss-parser';
import { query } from '../db/connection.js';
import {
  processIntelligenceItems,
  type RawIntelligenceItem,
} from '../services/intelligence.service.js';
import { youSearch, isYouSearchEnabled } from '../services/you-search.service.js';
import { venueSearchQueries, venueNamesLower } from '../services/target-venues.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PublishingSource {
  name: string;
  url: string;
  type: 'rss';
}

// ─── Default Publishing Sources ──────────────────────────────────────────────

const DEFAULT_PUBLISHING_SOURCES: PublishingSource[] = [
  {
    name: 'Publishers Weekly',
    url: 'https://www.publishersweekly.com/pw/rss/index.html',
    type: 'rss',
  },
  {
    name: 'Poets & Writers',
    url: 'https://www.pw.org/content/feed',
    type: 'rss',
  },
  {
    name: 'Literary Hub',
    url: 'https://lithub.com/feed/',
    type: 'rss',
  },
  // Note: The Review Review was previously listed here but appears defunct
  // (the site stopped publishing), so it was removed rather than fetched pointlessly.
];

// ─── You.com Search Queries ──────────────────────────────────────────────────
// Industry RSS feeds report *news*; they rarely list individual journals' open
// reading periods. These web searches surface actual places to submit — the
// currency that matters for placing essays ahead of a book query.

// Generic discovery queries, plus one query per curated target venue (derived
// from target-venues.ts) so the scanner tracks the writer's actual targets.
const GENERIC_SEARCH_QUERIES = [
  'literary magazines open for submissions personal essay creative nonfiction',
  'literary journal open reading period memoir submissions',
  'call for submissions essays creative nonfiction deadline',
];

function defaultSearchQueries(): string[] {
  return [...GENERIC_SEARCH_QUERIES, ...venueSearchQueries()];
}

// ─── Publishing Relevance Keywords ──────────────────────────────────────────

// Relevance is a conjunction, not a single keyword hit: an item must show
// SUBMISSION INTENT *and* be about this writer's GENRE. The previous filter
// admitted anything containing 'essay', 'literary', or 'journal', which let
// general book coverage flood the Publishing tab and buried actual openings.

const SUBMISSION_INTENT_KEYWORDS = [
  'submission',
  'submissions',
  'submit',
  'open reading',
  'reading period',
  'call for',
  'accepting',
  'guidelines',
  'deadline',
  'contest',
  'prize',
  'award',
  'competition',
  'anthology',
  'literary agent',
];

const GENRE_KEYWORDS = [
  'memoir',
  'essay',
  'personal essay',
  'creative nonfiction',
  'narrative nonfiction',
  'nonfiction',
  'literary magazine',
  'literary journal',
];

// ─── Categorization Keywords ─────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  agent_movement: ['agent', 'literary agent', 'new agent', 'agent move', 'representation', 'query'],
  submission_window: ['submission', 'open reading', 'call for', 'accepting', 'submit', 'guidelines'],
  contest_deadline: ['contest', 'prize', 'award', 'competition', 'deadline', 'winner'],
  market_trend: ['trend', 'market', 'industry', 'sales', 'publishing landscape', 'book deal'],
};

// ─── Publishing Scanner Job ──────────────────────────────────────────────────

const parser = new RssParser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Quinn Writing Studio Intelligence Scanner/1.0',
  },
});

/**
 * Main publishing scanner job function.
 * Scans publishing industry sources, filters for relevance,
 * categorizes items, and processes through the intelligence pipeline.
 */
export async function runPublishingScanner(userId: string): Promise<number> {
  console.log('[PublishingScanner] Starting publishing scan...');

  const sources = await getConfiguredSources(userId);
  const allItems: RawIntelligenceItem[] = [];

  for (const source of sources) {
    try {
      const items = await fetchPublishingSource(source);
      allItems.push(...items);
      console.log(`[PublishingScanner] Fetched ${items.length} items from ${source.name}`);
    } catch (error) {
      console.error(`[PublishingScanner] Error fetching ${source.name}:`, error);
    }
  }

  // Web search via you.com (if configured) — surfaces open submission calls and
  // reading periods that never appear in the industry RSS feeds.
  if (isYouSearchEnabled()) {
    const queries = await getYouSearchQueries(userId);
    for (const q of queries) {
      try {
        const items = await fetchFromYouSearch(q);
        allItems.push(...items);
        console.log(`[PublishingScanner] you.com "${q.slice(0, 40)}...": ${items.length} results`);
      } catch (error) {
        console.error(`[PublishingScanner] you.com search error for "${q}":`, error);
      }
    }
  }

  // Filter for publishing relevance
  const relevantItems = filterForRelevance(allItems);
  console.log(`[PublishingScanner] ${relevantItems.length}/${allItems.length} items passed relevance filter`);

  // Process through intelligence pipeline
  const storedCount = await processIntelligenceItems(relevantItems, 'publishing', userId);
  console.log(`[PublishingScanner] Completed. Stored ${storedCount} new publishing items.`);

  return storedCount;
}

/**
 * Fetch publishing opportunities from a you.com web search query.
 * Maps each search result into a RawIntelligenceItem for the pipeline.
 */
async function fetchFromYouSearch(searchQuery: string): Promise<RawIntelligenceItem[]> {
  const results = await youSearch(searchQuery, { count: 15, freshness: 'month' });

  return results.map((r) => {
    const content = [r.description, ...r.snippets].filter(Boolean).join(' ');
    return {
      title: r.title,
      source: r.url,
      sourceName: 'you.com search',
      content,
      publishedAt: r.pageAge ? new Date(r.pageAge) : undefined,
      deadline: extractDeadline(content, r.title),
      subcategory: categorizePublishingItem(r.title, content),
    };
  });
}

/**
 * Get configured you.com search queries from settings, or defaults.
 */
async function getYouSearchQueries(userId: string): Promise<string[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );
    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const queries = (schedules as Record<string, unknown>)['publishing_search_queries'] as
        | string[]
        | undefined;
      if (queries && Array.isArray(queries) && queries.length > 0) {
        return queries;
      }
    }
  } catch (error) {
    console.error('[PublishingScanner] Error loading you.com queries:', error);
  }
  return defaultSearchQueries();
}

/**
 * Get configured publishing sources from user settings, falling back to defaults.
 */
async function getConfiguredSources(userId: string): Promise<PublishingSource[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );

    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const publishingSources = (schedules as Record<string, unknown>)['publishing_sources'] as PublishingSource[] | undefined;
      if (publishingSources && Array.isArray(publishingSources) && publishingSources.length > 0) {
        return publishingSources;
      }
    }
  } catch (error) {
    console.error('[PublishingScanner] Error loading configured sources:', error);
  }

  return DEFAULT_PUBLISHING_SOURCES;
}

/**
 * Fetch items from a publishing RSS source.
 */
async function fetchPublishingSource(source: PublishingSource): Promise<RawIntelligenceItem[]> {
  const feed = await parser.parseURL(source.url);
  const items: RawIntelligenceItem[] = [];

  // Only process items from the last 14 days
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  for (const entry of feed.items) {
    if (!entry.title) continue;

    // Skip old items
    if (entry.pubDate) {
      const pubDate = new Date(entry.pubDate);
      if (pubDate < twoWeeksAgo) continue;
    }

    const content = entry.contentSnippet || entry.content || entry.summary || '';
    const deadline = extractDeadline(content, entry.title);
    const subcategory = categorizePublishingItem(entry.title, content);

    items.push({
      title: entry.title,
      source: entry.link || source.url,
      sourceName: source.name,
      content,
      publishedAt: entry.pubDate ? new Date(entry.pubDate) : undefined,
      deadline,
      subcategory,
    });
  }

  return items;
}

/**
 * Filter items for relevance to memoir/essay/creative nonfiction publishing.
 */
function filterForRelevance(items: RawIntelligenceItem[]): RawIntelligenceItem[] {
  const venues = venueNamesLower();

  return items.filter((item) => {
    const searchText = `${item.title} ${item.content}`.toLowerCase();

    // Anything about a curated target venue is relevant by definition.
    if (venues.some((v) => searchText.includes(v))) return true;

    const hasIntent = SUBMISSION_INTENT_KEYWORDS.some((k) => searchText.includes(k));
    const hasGenre = GENRE_KEYWORDS.some((k) => searchText.includes(k));
    return hasIntent && hasGenre;
  });
}

/**
 * Categorize a publishing item based on title and content keywords.
 */
function categorizePublishingItem(title: string, content: string): string {
  const text = `${title} ${content}`.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const matchCount = keywords.filter((kw) => text.includes(kw)).length;
    if (matchCount >= 2) return category;
  }

  // Single keyword match fallback
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }

  return 'industry_news';
}

/**
 * Extract deadline date from content text.
 */
function extractDeadline(content: string, title: string): Date | undefined {
  const text = `${title} ${content}`;

  const patterns = [
    /deadline[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /due[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /closes?[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /submit by[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed.getTime()) && parsed > new Date()) {
        return parsed;
      }
    }
  }

  return undefined;
}
