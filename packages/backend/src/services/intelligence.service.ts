import { query } from '../db/connection.js';
import { sendMessage } from './claude-api.service.js';
import { logApiUsage } from './usage-tracking.service.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type IntelligenceCategory = 'grant' | 'ai_news' | 'publishing';

export type IntelligenceStatus = 'new' | 'reviewed' | 'selected' | 'saved' | 'dismissed';

export interface RawIntelligenceItem {
  title: string;
  source: string;
  sourceName: string;
  content: string;
  publishedAt?: Date;
  deadline?: Date;
  eligibilitySummary?: string;
  awardDetails?: string;
  subcategory?: string;
}

export interface ProcessedIntelligenceItem {
  title: string;
  source: string;
  sourceName: string;
  summary: string;
  relevanceScore: number;
  subcategory: string | null;
  deadline: Date | null;
  eligibilitySummary: string | null;
  awardDetails: string | null;
  publishedAt: Date | null;
}

interface StoredItem {
  id: string;
  title: string;
  source: string;
}

// ─── Intelligence Job Pipeline ───────────────────────────────────────────────

/**
 * Process raw intelligence items through the full pipeline:
 * 1. AI summarization via Claude Sonnet
 * 2. Score and categorize
 * 3. Deduplicate against existing items
 * 4. Store in intelligence_items table
 */
export async function processIntelligenceItems(
  items: RawIntelligenceItem[],
  category: IntelligenceCategory,
  userId: string
): Promise<number> {
  if (items.length === 0) return 0;

  // Step 1: Deduplicate against existing items
  const uniqueItems = await deduplicateItems(items, category);

  if (uniqueItems.length === 0) return 0;

  // Step 2: AI summarization and scoring (batch for efficiency)
  const processed = await summarizeAndScore(uniqueItems, category, userId);

  // Step 3: Store in database
  let storedCount = 0;
  for (const item of processed) {
    await query(
      `INSERT INTO intelligence_items
       (category, subcategory, title, source, source_name, summary, relevance_score, deadline, eligibility_summary, award_details, status, published_at, discovered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11, NOW())`,
      [
        category,
        item.subcategory,
        item.title,
        item.source,
        item.sourceName,
        item.summary,
        item.relevanceScore,
        item.deadline,
        item.eligibilitySummary,
        item.awardDetails,
        item.publishedAt,
      ]
    );
    storedCount++;
  }

  console.log(`[Intelligence] Stored ${storedCount} new ${category} items`);
  return storedCount;
}

/**
 * Deduplicate items against existing intelligence_items by title similarity.
 * Returns only items that don't already exist in the database.
 */
export async function deduplicateItems(
  items: RawIntelligenceItem[],
  category: IntelligenceCategory
): Promise<RawIntelligenceItem[]> {
  // Load existing items for this category (last 90 days)
  const existingResult = await query<StoredItem>(
    `SELECT id, title, source FROM intelligence_items
     WHERE category = $1 AND discovered_at > NOW() - INTERVAL '90 days'`,
    [category]
  );

  const existingTitles = new Set(
    existingResult.rows.map((row) => normalizeTitle(row.title))
  );
  const existingSources = new Set(
    existingResult.rows.map((row) => row.source).filter(Boolean)
  );

  return items.filter((item) => {
    const normalizedTitle = normalizeTitle(item.title);

    // Check exact title match
    if (existingTitles.has(normalizedTitle)) {
      return false;
    }

    // Check source URL match
    if (item.source && existingSources.has(item.source)) {
      return false;
    }

    // Check fuzzy title similarity (Jaccard similarity on words)
    for (const existing of existingTitles) {
      if (titleSimilarity(normalizedTitle, existing) > 0.85) {
        return false;
      }
    }

    return true;
  });
}

// ─── AI Summarization and Scoring ────────────────────────────────────────────

/**
 * Use Claude Sonnet to summarize and score intelligence items.
 * Processes items in batches to reduce API calls.
 */
async function summarizeAndScore(
  items: RawIntelligenceItem[],
  category: IntelligenceCategory,
  userId: string
): Promise<ProcessedIntelligenceItem[]> {
  const BATCH_SIZE = 5;
  const results: ProcessedIntelligenceItem[] = [];

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchResults = await processBatch(batch, category, userId);
    results.push(...batchResults);
  }

  return results;
}

async function processBatch(
  items: RawIntelligenceItem[],
  category: IntelligenceCategory,
  userId: string
): Promise<ProcessedIntelligenceItem[]> {
  const systemPrompt = getCategorizationPrompt(category);

  const itemDescriptions = items
    .map(
      (item, idx) =>
        `[Item ${idx + 1}]\nTitle: ${item.title}\nSource: ${item.sourceName}\nContent: ${item.content.slice(0, 1000)}\n${item.deadline ? `Deadline: ${item.deadline.toISOString().split('T')[0]}` : ''}\n${item.eligibilitySummary ? `Eligibility: ${item.eligibilitySummary}` : ''}\n${item.awardDetails ? `Award: ${item.awardDetails}` : ''}`
    )
    .join('\n\n---\n\n');

  const response = await sendMessage({
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Please analyze and summarize the following ${category} items:\n\n${itemDescriptions}`,
      },
    ],
    model: 'sonnet',
  });

  // Log API usage
  await logApiUsage(
    userId,
    'sonnet',
    'intelligence',
    response.inputTokens,
    response.outputTokens
  );

  // Parse the response
  const parsed = parseCategorizationResponse(response.content, items);
  return parsed;
}

function getCategorizationPrompt(category: IntelligenceCategory): string {
  const basePrompt = `You are an intelligence curator for a memoir/essay writer. Analyze the provided items and return a JSON array with one object per item.

Each object must have:
- "summary": A concise 1-2 sentence summary of the opportunity/news
- "relevance_score": A float from 0.0 to 1.0 indicating relevance to a memoir/essay/creative nonfiction writer
- "subcategory": A categorization string`;

  switch (category) {
    case 'grant':
      return `${basePrompt}

For grants, subcategory should be one of: "fellowship", "residency", "project_grant", "prize", "scholarship"
Score higher for: memoir-specific grants, essay collections, creative nonfiction, literary arts. Score lower for: fiction-only, poetry-only, academic research, STEM.

Return ONLY a JSON array, no other text. Example:
[{"summary": "...", "relevance_score": 0.8, "subcategory": "fellowship"}]`;

    case 'ai_news':
      return `${basePrompt}

For AI news, subcategory should be one of: "tool_launch", "research", "industry", "ethics", "creative_ai", "policy"
Score higher for: topics that can be demystified for a general audience, AI tools affecting writers, creative AI developments, AI ethics debates. Score lower for: highly technical ML papers, enterprise B2B news, cryptocurrency/blockchain.

Return ONLY a JSON array, no other text. Example:
[{"summary": "...", "relevance_score": 0.8, "subcategory": "tool_launch"}]`;

    case 'publishing':
      return `${basePrompt}

For publishing intelligence, subcategory should be one of: "agent_movement", "submission_window", "contest_deadline", "market_trend", "industry_news"
Score higher for: memoir/essay markets, creative nonfiction agents, literary magazine submissions, essay contests. Score lower for: genre fiction markets, children's publishing, academic journals.

Return ONLY a JSON array, no other text. Example:
[{"summary": "...", "relevance_score": 0.8, "subcategory": "submission_window"}]`;

    default:
      return basePrompt;
  }
}

function parseCategorizationResponse(
  content: string,
  originalItems: RawIntelligenceItem[]
): ProcessedIntelligenceItem[] {
  try {
    // Extract JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[Intelligence] Failed to extract JSON from response');
      return fallbackProcessing(originalItems);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      summary: string;
      relevance_score: number;
      subcategory: string;
    }>;

    return originalItems.map((item, idx) => {
      const aiResult = parsed[idx];
      return {
        title: item.title,
        source: item.source,
        sourceName: item.sourceName,
        summary: aiResult?.summary || item.content.slice(0, 200),
        relevanceScore: Math.min(1, Math.max(0, aiResult?.relevance_score ?? 0.5)),
        subcategory: aiResult?.subcategory || item.subcategory || null,
        deadline: item.deadline || null,
        eligibilitySummary: item.eligibilitySummary || null,
        awardDetails: item.awardDetails || null,
        publishedAt: item.publishedAt || null,
      };
    });
  } catch (error) {
    console.error('[Intelligence] Error parsing AI response:', error);
    return fallbackProcessing(originalItems);
  }
}

/**
 * Fallback processing when AI categorization fails.
 * Uses the raw content as summary with a default relevance score.
 */
function fallbackProcessing(items: RawIntelligenceItem[]): ProcessedIntelligenceItem[] {
  return items.map((item) => ({
    title: item.title,
    source: item.source,
    sourceName: item.sourceName,
    summary: item.content.slice(0, 200),
    relevanceScore: 0.5,
    subcategory: item.subcategory || null,
    deadline: item.deadline || null,
    eligibilitySummary: item.eligibilitySummary || null,
    awardDetails: item.awardDetails || null,
    publishedAt: item.publishedAt || null,
  }));
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Normalize a title for comparison (lowercase, remove punctuation, trim).
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Jaccard similarity between two title strings (word-level).
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 2));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
