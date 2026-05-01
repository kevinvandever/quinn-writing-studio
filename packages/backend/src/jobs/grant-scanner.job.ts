import RssParser from 'rss-parser';
import { query } from '../db/connection.js';
import {
  processIntelligenceItems,
  type RawIntelligenceItem,
} from '../services/intelligence.service.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GrantSource {
  name: string;
  url: string;
  type: 'rss';
}

// ─── Default Grant Sources ───────────────────────────────────────────────────

const DEFAULT_GRANT_SOURCES: GrantSource[] = [
  {
    name: 'Grants.gov - Arts',
    url: 'https://www.grants.gov/rss/GG_OppModByCategory_Arts.xml',
    type: 'rss',
  },
  {
    name: 'Poets & Writers',
    url: 'https://www.pw.org/grants/feed',
    type: 'rss',
  },
  {
    name: 'AWP',
    url: 'https://www.awpwriter.org/contests/overview/feed',
    type: 'rss',
  },
  {
    name: 'State Arts Councils',
    url: 'https://nasaa-arts.org/nasaa_research/grants-programs/feed/',
    type: 'rss',
  },
];

// ─── Relevance Keywords ──────────────────────────────────────────────────────

const RELEVANCE_KEYWORDS = [
  'memoir',
  'essay',
  'creative nonfiction',
  'nonfiction',
  'literary',
  'writing',
  'writer',
  'author',
  'prose',
  'narrative',
  'personal essay',
  'literary arts',
  'creative writing',
  'fellowship',
  'residency',
  'arts grant',
];

// ─── Grant Scanner Job ───────────────────────────────────────────────────────

const parser = new RssParser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Quinn Writing Studio Intelligence Scanner/1.0',
  },
});

/**
 * Main grant scanner job function.
 * Fetches from configured RSS sources, filters for relevance,
 * extracts grant details, and processes through the intelligence pipeline.
 */
export async function runGrantScanner(userId: string): Promise<number> {
  console.log('[GrantScanner] Starting grant scan...');

  const sources = await getConfiguredSources(userId);
  const allItems: RawIntelligenceItem[] = [];

  for (const source of sources) {
    try {
      const items = await fetchGrantSource(source);
      allItems.push(...items);
      console.log(`[GrantScanner] Fetched ${items.length} items from ${source.name}`);
    } catch (error) {
      console.error(`[GrantScanner] Error fetching ${source.name}:`, error);
    }
  }

  // Filter for relevance to memoir/essay/creative nonfiction
  const relevantItems = filterForRelevance(allItems);
  console.log(`[GrantScanner] ${relevantItems.length}/${allItems.length} items passed relevance filter`);

  // Process through intelligence pipeline
  const storedCount = await processIntelligenceItems(relevantItems, 'grant', userId);
  console.log(`[GrantScanner] Completed. Stored ${storedCount} new grant items.`);

  return storedCount;
}

/**
 * Get configured grant sources from user settings, falling back to defaults.
 */
async function getConfiguredSources(userId: string): Promise<GrantSource[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );

    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const grantSources = (schedules as Record<string, unknown>)['grant_sources'] as GrantSource[] | undefined;
      if (grantSources && Array.isArray(grantSources) && grantSources.length > 0) {
        return grantSources;
      }
    }
  } catch (error) {
    console.error('[GrantScanner] Error loading configured sources:', error);
  }

  return DEFAULT_GRANT_SOURCES;
}

/**
 * Fetch grants from an RSS source.
 */
async function fetchGrantSource(source: GrantSource): Promise<RawIntelligenceItem[]> {
  const feed = await parser.parseURL(source.url);
  const items: RawIntelligenceItem[] = [];

  for (const entry of feed.items) {
    if (!entry.title) continue;

    const content = entry.contentSnippet || entry.content || entry.summary || '';
    const deadline = extractDeadline(content, entry.title);
    const eligibility = extractEligibility(content);
    const award = extractAwardDetails(content);

    items.push({
      title: entry.title,
      source: entry.link || source.url,
      sourceName: source.name,
      content,
      publishedAt: entry.pubDate ? new Date(entry.pubDate) : undefined,
      deadline,
      eligibilitySummary: eligibility,
      awardDetails: award,
      subcategory: categorizeGrant(entry.title, content),
    });
  }

  return items;
}

/**
 * Filter items for relevance to memoir/essay/creative nonfiction.
 */
function filterForRelevance(items: RawIntelligenceItem[]): RawIntelligenceItem[] {
  return items.filter((item) => {
    const searchText = `${item.title} ${item.content}`.toLowerCase();
    return RELEVANCE_KEYWORDS.some((keyword) => searchText.includes(keyword));
  });
}

/**
 * Extract deadline date from content text.
 */
function extractDeadline(content: string, title: string): Date | undefined {
  const text = `${title} ${content}`;

  // Match common date patterns
  const patterns = [
    /deadline[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /due[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /closes?[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
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

/**
 * Extract eligibility information from content.
 */
function extractEligibility(content: string): string | undefined {
  const patterns = [
    /eligib(?:le|ility)[:\s]+([^.]+\.)/i,
    /open to[:\s]+([^.]+\.)/i,
    /applicants? must[:\s]+([^.]+\.)/i,
    /who can apply[:\s]+([^.]+\.)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Extract award/prize details from content.
 */
function extractAwardDetails(content: string): string | undefined {
  const patterns = [
    /award[:\s]+([^.]+\.)/i,
    /prize[:\s]+([^.]+\.)/i,
    /\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?/,
    /stipend[:\s]+([^.]+\.)/i,
    /grant amount[:\s]+([^.]+\.)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return (match[1] || match[0]).trim();
    }
  }

  return undefined;
}

/**
 * Categorize a grant based on title and content.
 */
function categorizeGrant(title: string, content: string): string {
  const text = `${title} ${content}`.toLowerCase();

  if (text.includes('fellowship')) return 'fellowship';
  if (text.includes('residency') || text.includes('retreat')) return 'residency';
  if (text.includes('prize') || text.includes('award') || text.includes('contest')) return 'prize';
  if (text.includes('scholarship')) return 'scholarship';
  return 'project_grant';
}
