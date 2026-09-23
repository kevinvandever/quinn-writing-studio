/**
 * Writing Jobs Scanner
 *
 * Finds paid writing work. Job boards rarely publish usable RSS, so this is
 * web-search driven (you.com), with optional RSS sources if the writer configures
 * any.
 *
 * Default queries are weighted toward work this writer is actually credentialed
 * for — a long technology career, two published technical books, decades of trade
 * press bylines, plus AI explanatory writing — alongside general freelance
 * essay/editorial markets. Override via
 * settings.intelligence_schedules.writing_jobs_search_queries.
 */
import RssParser from 'rss-parser';
import { query } from '../db/connection.js';
import {
  processIntelligenceItems,
  type RawIntelligenceItem,
} from '../services/intelligence.service.js';
import { youSearch, isYouSearchEnabled } from '../services/you-search.service.js';

interface JobSource {
  name: string;
  url: string;
  type: 'rss';
}

// ─── Default Search Queries ──────────────────────────────────────────────────

const DEFAULT_SEARCH_QUERIES = [
  // Where his technical credentials command real rates
  'freelance technical writing jobs AI developer content',
  'freelance writer job artificial intelligence explainer content hiring',
  'contract technical writer remote hiring software documentation',
  // Editorial / essay work
  'freelance writing jobs personal essay paid submissions rates',
  'magazine seeking freelance writers pitches paid nonfiction',
  'ghostwriting jobs nonfiction book hiring',
];

// ─── Relevance Keywords ──────────────────────────────────────────────────────
// Require BOTH a hiring signal and a writing signal, so generic job listings and
// generic writing articles are both excluded.

const HIRING_KEYWORDS = [
  'hiring',
  'job',
  'jobs',
  'freelance',
  'contract',
  'apply',
  'position',
  'opening',
  'seeking',
  'wanted',
  'rate',
  'rates',
  'pays',
  'paid',
  'salary',
  'commission',
  'pitch',
  'pitches',
];

const WRITING_KEYWORDS = [
  'writer',
  'writing',
  'editor',
  'editorial',
  'copywriter',
  'content',
  'journalist',
  'ghostwriter',
  'ghostwriting',
  'technical writer',
  'essay',
  'nonfiction',
  'author',
];

// Listings that are almost never a fit — filtered out to reduce noise.
const EXCLUDE_KEYWORDS = [
  'unpaid',
  'volunteer',
  'no pay',
  'internship',
  'student only',
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  freelance: ['freelance', 'contract', 'gig', 'per article', 'per word', 'rate'],
  staff: ['full-time', 'full time', 'staff', 'salary', 'benefits', 'employee'],
  teaching: ['teach', 'teaching', 'instructor', 'workshop', 'faculty', 'adjunct'],
  call_for_pitches: ['pitch', 'pitches', 'submissions open', 'seeking submissions', 'call for'],
};

const parser = new RssParser({
  timeout: 30000,
  headers: { 'User-Agent': 'Quinn Writing Studio Intelligence Scanner/1.0' },
});

/**
 * Main writing-jobs scanner. Searches for paid writing work, filters for
 * relevance, categorizes, and runs items through the intelligence pipeline.
 */
export async function runWritingJobsScanner(userId: string): Promise<number> {
  console.log('[WritingJobsScanner] Starting writing jobs scan...');

  const allItems: RawIntelligenceItem[] = [];

  // Optional RSS sources (none by default — most job boards lack usable feeds)
  const sources = await getConfiguredSources(userId);
  for (const source of sources) {
    try {
      const items = await fetchFromRss(source);
      allItems.push(...items);
      console.log(`[WritingJobsScanner] Fetched ${items.length} items from ${source.name}`);
    } catch (error) {
      console.error(`[WritingJobsScanner] Error fetching ${source.name}:`, error);
    }
  }

  if (isYouSearchEnabled()) {
    const queries = await getSearchQueries(userId);
    for (const q of queries) {
      try {
        const items = await fetchFromYouSearch(q);
        allItems.push(...items);
        console.log(`[WritingJobsScanner] you.com "${q.slice(0, 40)}...": ${items.length} results`);
      } catch (error) {
        console.error(`[WritingJobsScanner] you.com search error for "${q}":`, error);
      }
    }
  } else {
    console.warn('[WritingJobsScanner] YOU_API_KEY not configured — no sources to scan.');
  }

  const relevantItems = filterForRelevance(allItems);
  console.log(
    `[WritingJobsScanner] ${relevantItems.length}/${allItems.length} items passed relevance filter`
  );

  const storedCount = await processIntelligenceItems(relevantItems, 'writing_jobs', userId);
  console.log(`[WritingJobsScanner] Completed. Stored ${storedCount} new writing job items.`);

  return storedCount;
}

/** Fetch job listings from a you.com search query. */
async function fetchFromYouSearch(searchQuery: string): Promise<RawIntelligenceItem[]> {
  // Jobs go stale fast, so restrict to the past week.
  const results = await youSearch(searchQuery, { count: 15, freshness: 'week' });

  return results.map((r) => {
    const content = [r.description, ...r.snippets].filter(Boolean).join(' ');
    return {
      title: r.title,
      source: r.url,
      sourceName: 'you.com search',
      content,
      publishedAt: r.pageAge ? new Date(r.pageAge) : undefined,
      deadline: extractDeadline(content, r.title),
      subcategory: categorizeJob(r.title, content),
    };
  });
}

/** Fetch items from an optional RSS job source. */
async function fetchFromRss(source: JobSource): Promise<RawIntelligenceItem[]> {
  const feed = await parser.parseURL(source.url);
  const items: RawIntelligenceItem[] = [];

  // Job postings age out quickly — only the last 14 days.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);

  for (const entry of feed.items) {
    if (!entry.title) continue;
    if (entry.pubDate && new Date(entry.pubDate) < cutoff) continue;

    const content = entry.contentSnippet || entry.content || entry.summary || '';
    items.push({
      title: entry.title,
      source: entry.link || source.url,
      sourceName: source.name,
      content,
      publishedAt: entry.pubDate ? new Date(entry.pubDate) : undefined,
      deadline: extractDeadline(content, entry.title),
      subcategory: categorizeJob(entry.title, content),
    });
  }

  return items;
}

/** Read configured search queries from settings, or fall back to defaults. */
async function getSearchQueries(userId: string): Promise<string[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );
    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const queries = (schedules as Record<string, unknown>)['writing_jobs_search_queries'] as
        | string[]
        | undefined;
      if (queries && Array.isArray(queries) && queries.length > 0) return queries;
    }
  } catch (error) {
    console.error('[WritingJobsScanner] Error loading search queries:', error);
  }
  return DEFAULT_SEARCH_QUERIES;
}

/** Read optional RSS sources from settings (none by default). */
async function getConfiguredSources(userId: string): Promise<JobSource[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );
    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const sources = (schedules as Record<string, unknown>)['writing_jobs_sources'] as
        | JobSource[]
        | undefined;
      if (sources && Array.isArray(sources) && sources.length > 0) return sources;
    }
  } catch (error) {
    console.error('[WritingJobsScanner] Error loading sources:', error);
  }
  return [];
}

/** Keep items that show both a hiring signal and a writing signal. */
function filterForRelevance(items: RawIntelligenceItem[]): RawIntelligenceItem[] {
  return items.filter((item) => {
    const text = `${item.title} ${item.content}`.toLowerCase();
    if (EXCLUDE_KEYWORDS.some((k) => text.includes(k))) return false;
    const hasHiring = HIRING_KEYWORDS.some((k) => text.includes(k));
    const hasWriting = WRITING_KEYWORDS.some((k) => text.includes(k));
    return hasHiring && hasWriting;
  });
}

/** Categorize the kind of work on offer. */
function categorizeJob(title: string, content: string): string {
  const text = `${title} ${content}`.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const matchCount = keywords.filter((kw) => text.includes(kw)).length;
    if (matchCount >= 2) return category;
  }
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }
  return 'other';
}

/** Extract an application deadline, if one is stated and still in the future. */
function extractDeadline(content: string, title: string): Date | undefined {
  const text = `${title} ${content}`;
  const patterns = [
    /deadline[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /apply by[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /closes?[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
    /(\d{1,2}\/\d{1,2}\/\d{4})/,
    /(\d{4}-\d{2}-\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed.getTime()) && parsed > new Date()) return parsed;
    }
  }
  return undefined;
}
