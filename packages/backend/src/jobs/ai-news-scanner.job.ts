import RssParser from 'rss-parser';
import { query } from '../db/connection.js';
import {
  processIntelligenceItems,
  type RawIntelligenceItem,
} from '../services/intelligence.service.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface NewsSource {
  name: string;
  url: string;
  type: 'rss';
}

// ─── Default AI News Sources ─────────────────────────────────────────────────

const DEFAULT_AI_NEWS_SOURCES: NewsSource[] = [
  {
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    type: 'rss',
  },
  {
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    type: 'rss',
  },
  {
    name: 'MIT Technology Review',
    url: 'https://www.technologyreview.com/feed/',
    type: 'rss',
  },
  {
    name: 'Ars Technica AI',
    url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',
    type: 'rss',
  },
];

// ─── AI Relevance Keywords ───────────────────────────────────────────────────

const AI_KEYWORDS = [
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'neural network',
  'large language model',
  'llm',
  'chatgpt',
  'claude',
  'gpt',
  'generative ai',
  'ai model',
  'ai tool',
  'ai ethics',
  'ai regulation',
  'ai safety',
  'openai',
  'anthropic',
  'google ai',
  'meta ai',
  'ai writing',
  'ai creative',
  'natural language',
  'transformer',
  'diffusion model',
  'ai assistant',
  'copilot',
];

// ─── AI News Scanner Job ─────────────────────────────────────────────────────

const parser = new RssParser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Quinn Writing Studio Intelligence Scanner/1.0',
  },
});

/**
 * Main AI news scanner job function.
 * Aggregates AI news from configured RSS sources, filters for AI relevance,
 * and processes through the intelligence pipeline with demystification scoring.
 */
export async function runAiNewsScanner(userId: string): Promise<number> {
  console.log('[AiNewsScanner] Starting AI news scan...');

  const sources = await getConfiguredSources(userId);
  const allItems: RawIntelligenceItem[] = [];

  for (const source of sources) {
    try {
      const items = await fetchNewsSource(source);
      allItems.push(...items);
      console.log(`[AiNewsScanner] Fetched ${items.length} items from ${source.name}`);
    } catch (error) {
      console.error(`[AiNewsScanner] Error fetching ${source.name}:`, error);
    }
  }

  // Filter for AI relevance
  const relevantItems = filterForAiRelevance(allItems);
  console.log(`[AiNewsScanner] ${relevantItems.length}/${allItems.length} items passed AI relevance filter`);

  // Process through intelligence pipeline (Claude will score for demystification potential)
  const storedCount = await processIntelligenceItems(relevantItems, 'ai_news', userId);
  console.log(`[AiNewsScanner] Completed. Stored ${storedCount} new AI news items.`);

  return storedCount;
}

/**
 * Get configured AI news sources from user settings, falling back to defaults.
 */
async function getConfiguredSources(userId: string): Promise<NewsSource[]> {
  try {
    const result = await query<{ intelligence_schedules: Record<string, unknown> | null }>(
      `SELECT intelligence_schedules FROM settings WHERE user_id = $1`,
      [userId]
    );

    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      const newsSources = (schedules as Record<string, unknown>)['ai_news_sources'] as NewsSource[] | undefined;
      if (newsSources && Array.isArray(newsSources) && newsSources.length > 0) {
        return newsSources;
      }
    }
  } catch (error) {
    console.error('[AiNewsScanner] Error loading configured sources:', error);
  }

  return DEFAULT_AI_NEWS_SOURCES;
}

/**
 * Fetch news items from an RSS source.
 */
async function fetchNewsSource(source: NewsSource): Promise<RawIntelligenceItem[]> {
  const feed = await parser.parseURL(source.url);
  const items: RawIntelligenceItem[] = [];

  // Only process items from the last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (const entry of feed.items) {
    if (!entry.title) continue;

    // Skip old items
    if (entry.pubDate) {
      const pubDate = new Date(entry.pubDate);
      if (pubDate < sevenDaysAgo) continue;
    }

    const content = entry.contentSnippet || entry.content || entry.summary || '';

    items.push({
      title: entry.title,
      source: entry.link || source.url,
      sourceName: source.name,
      content,
      publishedAt: entry.pubDate ? new Date(entry.pubDate) : undefined,
    });
  }

  return items;
}

/**
 * Filter items for AI relevance based on keywords in title and content.
 */
function filterForAiRelevance(items: RawIntelligenceItem[]): RawIntelligenceItem[] {
  return items.filter((item) => {
    const searchText = `${item.title} ${item.content}`.toLowerCase();
    return AI_KEYWORDS.some((keyword) => searchText.includes(keyword));
  });
}
