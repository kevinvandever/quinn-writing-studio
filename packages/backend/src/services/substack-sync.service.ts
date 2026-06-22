/**
 * Substack Sync Service
 *
 * Fetches published posts via RSS feed and optionally drafts via unofficial REST API.
 * Parses content, extracts metadata, and stores as corpus documents.
 */

import Parser from 'rss-parser';
import { query } from '../db/connection.js';
import { decrypt } from '../utils/encryption.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubstackPost {
  title: string;
  content: string;
  wordCount: number;
  publishedAt: Date;
  url: string;
  guid: string;
}

export interface SubstackConnection {
  id: string;
  project_id: string;
  publication_url: string;
  publication_name: string | null;
  auth_cookies: string | null;
  last_sync_at: Date | null;
  sync_status: string;
  sync_error: string | null;
}

export interface SyncResult {
  postsFound: number;
  newPosts: number;
  posts: SubstackPost[];
  errors: string[];
}

// ─── RSS Feed Parsing ────────────────────────────────────────────────────────

const rssParser = new Parser({
  customFields: {
    item: ['content:encoded'],
  },
});

/**
 * Strip HTML tags from content and return plain text.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count words in a text string.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Decrypt a stored auth-cookie value. Encrypted values are "iv:authTag:cipher"
 * (hex); legacy values were stored as raw cookie strings, so those are passed
 * through unchanged for backward compatibility.
 */
function decryptAuthCookies(stored: string): string {
  const parts = stored.split(':');
  const looksEncrypted =
    parts.length === 3 &&
    /^[0-9a-f]{24}$/i.test(parts[0]!) &&
    /^[0-9a-f]{32}$/i.test(parts[1]!) &&
    /^[0-9a-f]+$/i.test(parts[2]!);
  if (!looksEncrypted) return stored;
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
}

/**
 * Fetch published posts from a Substack RSS feed.
 */
export async function fetchPublishedPosts(publicationUrl: string): Promise<SubstackPost[]> {
  // Normalize the URL to get the feed URL
  const feedUrl = normalizeFeedUrl(publicationUrl);

  const feed = await rssParser.parseURL(feedUrl);

  const posts: SubstackPost[] = [];

  for (const item of feed.items) {
    const htmlContent = (item as unknown as Record<string, unknown>)['content:encoded'] as string
      || item.content
      || '';
    const plainContent = stripHtml(htmlContent);
    const wordCount = countWords(plainContent);

    posts.push({
      title: item.title || 'Untitled',
      content: plainContent,
      wordCount,
      publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
      url: item.link || '',
      guid: item.guid || item.link || item.title || '',
    });
  }

  return posts;
}

/**
 * Optionally fetch drafts via unofficial Substack REST API with session cookie auth.
 * This is best-effort and may break if Substack changes their API.
 */
export async function fetchDrafts(
  publicationUrl: string,
  authCookies: string
): Promise<SubstackPost[]> {
  try {
    const baseUrl = publicationUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/v1/drafts`, {
      headers: {
        Cookie: authCookies,
        'User-Agent': 'Quinn Writing Studio/1.0',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch Substack drafts: ${response.status}`);
      return [];
    }

    const drafts = (await response.json()) as Array<{
      title?: string;
      body_html?: string;
      post_date?: string;
      slug?: string;
      id?: string;
    }>;

    return drafts.map((draft) => {
      const plainContent = stripHtml(draft.body_html || '');
      return {
        title: draft.title || 'Untitled Draft',
        content: plainContent,
        wordCount: countWords(plainContent),
        publishedAt: draft.post_date ? new Date(draft.post_date) : new Date(),
        url: `${baseUrl}/p/${draft.slug || draft.id || ''}`,
        guid: `draft-${draft.id || draft.slug || ''}`,
      };
    });
  } catch (err) {
    console.warn('Failed to fetch Substack drafts:', err);
    return [];
  }
}

/**
 * Sync posts from Substack and store as corpus documents.
 * Returns sync result with counts and any errors.
 */
export async function syncSubstackPosts(
  connection: SubstackConnection,
  userId: string
): Promise<SyncResult> {
  const errors: string[] = [];
  let posts: SubstackPost[] = [];

  try {
    // Fetch published posts via RSS
    posts = await fetchPublishedPosts(connection.publication_url);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error fetching RSS feed';
    errors.push(message);

    // Update connection status to error
    await query(
      `UPDATE substack_connections
       SET sync_status = 'error', sync_error = $1
       WHERE id = $2`,
      [message, connection.id]
    );

    return { postsFound: 0, newPosts: 0, posts: [], errors };
  }

  // Optionally fetch drafts if auth cookies are available
  if (connection.auth_cookies) {
    try {
      const cookies = decryptAuthCookies(connection.auth_cookies);
      const drafts = await fetchDrafts(connection.publication_url, cookies);
      posts = [...posts, ...drafts];
    } catch (err) {
      errors.push('Failed to fetch drafts (non-critical)');
    }
  }

  // Store new posts as corpus documents; refresh existing ones (drafts change
  // between syncs, so we update content rather than skipping).
  let newPostCount = 0;

  for (const post of posts) {
    // Check if this post already exists (by guid/source_id)
    const existing = await query<{ id: string }>(
      `SELECT id FROM corpus_documents
       WHERE project_id = $1 AND source_type = 'substack' AND source_id = $2`,
      [connection.project_id, post.guid]
    );

    const metadata = JSON.stringify({
      published_at: post.publishedAt.toISOString(),
      url: post.url,
    });

    if (existing.rows.length === 0) {
      // Insert new corpus document
      await query(
        `INSERT INTO corpus_documents (project_id, source_type, source_id, title, content, word_count, metadata)
         VALUES ($1, 'substack', $2, $3, $4, $5, $6)`,
        [connection.project_id, post.guid, post.title, post.content, post.wordCount, metadata]
      );
      newPostCount++;

      // Log activity event for new items
      await query(
        `INSERT INTO activity_events (user_id, project_id, event_type, metadata)
         VALUES ($1, $2, 'substack_publish', $3)`,
        [
          userId,
          connection.project_id,
          JSON.stringify({
            title: post.title,
            word_count: post.wordCount,
            published_at: post.publishedAt.toISOString(),
            url: post.url,
          }),
        ]
      );
    } else {
      // Refresh existing document so edited drafts/posts stay current
      await query(
        `UPDATE corpus_documents
         SET title = $1, content = $2, word_count = $3, metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb, updated_at = NOW()
         WHERE id = $5`,
        [post.title, post.content, post.wordCount, metadata, existing.rows[0]!.id]
      );
    }
  }

  // Update connection status
  await query(
    `UPDATE substack_connections
     SET sync_status = 'ok', last_sync_at = NOW(), sync_error = NULL
     WHERE id = $1`,
    [connection.id]
  );

  return {
    postsFound: posts.length,
    newPosts: newPostCount,
    posts,
    errors,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a publication URL to its RSS feed URL.
 */
function normalizeFeedUrl(publicationUrl: string): string {
  const url = publicationUrl.replace(/\/$/, '');

  // If it already ends with /feed, use as-is
  if (url.endsWith('/feed')) {
    return url;
  }

  return `${url}/feed`;
}
