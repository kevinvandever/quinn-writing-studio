/**
 * RTF Parser Utility
 *
 * Strips RTF control words and formatting to extract plain text.
 * Uses regex-based parsing to handle common RTF elements.
 */

/**
 * Strip RTF formatting and return plain text content.
 * Handles common RTF elements: headers, fonts, colors, paragraphs, special characters.
 */
export function stripRtf(rtfContent: string): string {
  if (!rtfContent || typeof rtfContent !== 'string') {
    return '';
  }

  // Check if this is actually RTF content
  if (!rtfContent.startsWith('{\\rtf')) {
    // Not RTF — return as-is (might be plain text already)
    return rtfContent.trim();
  }

  let text = rtfContent;

  // Remove RTF header groups: {\fonttbl...}, {\colortbl...}, {\stylesheet...}, {\info...}
  text = removeGroupsByKeyword(text, [
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'header',
    'footer',
    'headerf',
    'footerf',
    'pict',
    'object',
    'fldinst',
  ]);

  // Handle special RTF escape sequences before stripping control words
  // Unicode characters: \uN followed by a replacement char
  text = text.replace(/\\u(\d+)\s?\??/g, (_match, code) => {
    const charCode = parseInt(code, 10);
    return String.fromCharCode(charCode);
  });

  // Negative unicode (for chars > 32767)
  text = text.replace(/\\u-(\d+)\s?\??/g, (_match, code) => {
    const charCode = 65536 - parseInt(code, 10);
    return String.fromCharCode(charCode);
  });

  // Named special characters
  text = text.replace(/\\emdash\b/g, '—');
  text = text.replace(/\\endash\b/g, '–');
  text = text.replace(/\\bullet\b/g, '•');
  text = text.replace(/\\lquote\b/g, '\u2018');
  text = text.replace(/\\rquote\b/g, '\u2019');
  text = text.replace(/\\ldblquote\b/g, '\u201C');
  text = text.replace(/\\rdblquote\b/g, '\u201D');
  text = text.replace(/\\tab\b/g, '\t');

  // Hex-encoded characters: \'XX, in Windows-1252 (Scrivener writes
  // \ansicpg1252). Read as Latin-1, 0x80-0x9F would be control characters
  // instead of curly quotes, apostrophes, and dashes.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => {
    const byte = parseInt(hex, 16);
    return byte >= 0x80 && byte <= 0x9f ? (CP1252_CONTROLS[byte] ?? '') : String.fromCharCode(byte);
  });

  // Paragraph and line breaks
  text = text.replace(/\\par\b\s?/g, '\n');
  text = text.replace(/\\line\b\s?/g, '\n');

  // Remove remaining control words (e.g., \b, \i, \fs24, \cf1, etc.)
  text = text.replace(/\\[a-z]+(-?\d+)?\s?/g, '');

  // Remove escaped special characters: \{, \}, \\
  text = text.replace(/\\([{}\\])/g, '$1');

  // Remove remaining braces
  text = text.replace(/[{}]/g, '');

  // Clean up whitespace
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/\r/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n /g, '\n');
  text = text.replace(/ \n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Remove null bytes (PostgreSQL rejects these in text columns)
  text = text.replace(/\0/g, '');

  return text.trim();
}

/**
 * Windows-1252 characters in the 0x80-0x9F range. RTF writes curly quotes,
 * apostrophes, and dashes as \'91-\'97; decoded as Latin-1 they become
 * invisible control characters (U+0080-U+009F).
 */
const CP1252_CONTROLS: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** Replace U+0080-U+009F control characters with the Windows-1252 characters they stand for. */
export function decodeCp1252Controls(text: string): string {
  return text.replace(/[\u0080-\u009f]/g, (c) => CP1252_CONTROLS[c.charCodeAt(0)] ?? '');
}

/**
 * Remove RTF groups that start with a specific keyword.
 * Handles nested braces correctly.
 */
function removeGroupsByKeyword(text: string, keywords: string[]): string {
  for (const keyword of keywords) {
    // Find groups starting with {\keyword
    const pattern = new RegExp(`\\{\\\\${keyword}\\b`, 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const startIndex = match.index;
      let depth = 1;
      let i = startIndex + match[0].length;

      while (i < text.length && depth > 0) {
        if (text[i] === '{' && text[i - 1] !== '\\') {
          depth++;
        } else if (text[i] === '}' && text[i - 1] !== '\\') {
          depth--;
        }
        i++;
      }

      // Remove the entire group
      text = text.slice(0, startIndex) + text.slice(i);
      // Reset pattern to search from the beginning since we modified the string
      pattern.lastIndex = startIndex;
    }
  }

  return text;
}
