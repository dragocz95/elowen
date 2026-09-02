import { z } from 'zod';
import { SEARCH_MAX_CANDIDATES, SEARCH_MAX_QUERY_CHARS, SEARCH_MAX_TEXT_CHARS } from '../../search/siteSearchRank.js';

/** The bounds are the SAME constants the ranking module documents, so the wire contract and the work it
 *  implies cannot drift apart. Both surfaces are client-driven — the palette sends its whole index on
 *  every call — and an over-limit request is refused (400) rather than silently truncated: a truncated
 *  candidate list would answer with a ranking over a set the caller never chose. */
const query = z.string().trim().min(1, 'query cannot be empty').max(SEARCH_MAX_QUERY_CHARS, 'query too long');
const id = z.string().trim().min(1, 'id cannot be empty').max(SEARCH_MAX_TEXT_CHARS, 'id too long');

/** Rank the caller's own candidates against `query` by embedding similarity. `text` is whatever stands
 *  for the row (the palette concatenates title, subtitle and keywords); the daemon never interprets it
 *  beyond embedding it. */
export const searchRankSchema = z.object({
  query,
  candidates: z.array(z.object({
    id,
    text: z.string().trim().min(1, 'text cannot be empty').max(SEARCH_MAX_TEXT_CHARS, 'text too long'),
  })).max(SEARCH_MAX_CANDIDATES, 'too many candidates'),
});

/** Ask a cheap model which candidates answer `query`. The model sees what the user would have read —
 *  the rendered title and subtitle — and answers with ids from this very list. */
export const searchAskSchema = z.object({
  query,
  candidates: z.array(z.object({
    id,
    title: z.string().trim().min(1, 'title cannot be empty').max(SEARCH_MAX_TEXT_CHARS, 'title too long'),
    subtitle: z.string().trim().max(SEARCH_MAX_TEXT_CHARS, 'subtitle too long').optional(),
  })).max(SEARCH_MAX_CANDIDATES, 'too many candidates'),
});
