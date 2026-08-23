/**
 * Escape special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parsePositiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Extract a section from text between start and end markers.
 */
export function extractSection(text: string, startMarker: string, endMarker?: string): string | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  if (!endMarker) return text.substring(contentStart);
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) return text.substring(contentStart);
  return text.substring(contentStart, endIdx);
}

/**
 * Truncate a string to maxLength, appending an indicator if truncated.
 */
export function truncate(str: string, maxLength: number, indicator = '...[truncated]'): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '\n' + indicator;
}
