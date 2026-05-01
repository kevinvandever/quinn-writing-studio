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

  // Hex-encoded characters: \'XX
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
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

  return text.trim();
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
