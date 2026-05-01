import RssParser from 'rss-parser';
import { query } from '../db/connection.js';
import {
  processIntelligenceItems,
  type RawIntelligenceItem,
} from '../services/intelligence.service.js';

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
  {
    name: 'The Review Review',
    url: 'https://www.thereviewreview.net/feed/',
    type: 'rss',
  },
];

// ─── Publishing Relevance Keywords ──────────────────────────────────────────

const PUBLISHING_KEYWORDS = [
  'memoir',
  'essay',
  'creative nonfiction',
  'nonfiction',
  'literary',
  'agent',
  'submission',
  'contest',
  'prize',
  'award',
  'anthology',
  'literary magazine',
  'journal',
  'publisher',
  'editor',
  'manuscript',
  'query',
  'book deal',
  'debut',
  'personal essay',
  'narrative nonfiction',
  'literary agent',
  'open reading',
  'call for submissions',
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

  // Filter for publishing relevance
  const relevantItems = filterForRelevance(allItems);
  console.log(`[PublishingScanner] ${relevantItems.length}/${allItems.length} items passed relevance filter`);

  // Process through intelligence pipeline
  const storedCount = await processIntelligenceItems(relevantItems, 'publishing', userId);
  console.log(`[PublishingScanner] Completed. Stored ${storedCount} new publishing items.`);

  return storedCount;
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
  return items.filter((item) => {
    const searchText = `${item.title} ${item.content}`.toLowerCase();
    return PUBLISHING_KEYWORDS.some((keyword) => searchText.includes(keyword));
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
