import type { ToolDefinition } from './types'
import { fail, num, ok, requireString } from './types'
import { settings } from '../settings'
import { recordActivity } from '../activity'

function localOnly(): string | null {
  return settings.get().privacy.localOnly
    ? 'Local-only mode is enabled in Settings → Privacy. Internet access is blocked. Ask the user to disable local-only mode if web access is required.'
    : null
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

export async function searchWeb(query: string, maxResults = 8): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'text/html'
    },
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}. Check your connection.`)
  const html = await res.text()
  const results: SearchResult[] = []
  const anchorRe = /<a\b([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(html)) && results.length < maxResults) {
    const attrs = match[1]
    const href = /href="([^"]+)"/i.exec(attrs)?.[1]
    if (!href) continue
    let url = href
    const redirect = /[?&]uddg=([^&]+)/.exec(href)
    if (redirect) {
      try {
        url = decodeURIComponent(redirect[1])
      } catch {
        url = href
      }
    }
    if (url.startsWith('//')) url = `https:${url}`
    const title = htmlToText(match[2])
    if (!title || !/^https?:/i.test(url)) continue
    results.push({ title, url })
  }
  // Attach snippets by position when available.
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/gi
  const snippets: string[] = []
  while ((match = snippetRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(htmlToText(match[1]).slice(0, 400))
  }
  return results.map((r, i) => ({ ...r, snippet: snippets[i] }))
}

export const webTools: ToolDefinition[] = [
  {
    name: 'web.fetch',
    description:
      'Fetch a public http(s) page and return readable text. Use for documentation, GitHub files and error research. Internet access only.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number', description: 'Default 12000, max 40000.' }
      },
      required: ['url']
    },
    risk: 'low',
    category: 'web',
    group: 'web',
    source: 'builtin',
    enabled: () => !settings.get().privacy.localOnly,
    preview: (args) => `Fetch ${String(args.url)}`,
    handler: async (args) => {
      const url = requireString(args, 'url')
      if (!/^https?:\/\//i.test(url)) return fail('Only http(s) URLs are supported.')
      const maxChars = Math.min(num(args.maxChars, 12000), 40000)
      recordActivity('web', `Fetched ${url}`)
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalPilotAI/0.1',
            Accept: 'text/html,application/json,text/plain,*/*'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(25000)
        })
        const contentType = res.headers.get('content-type') ?? ''
        const raw = await res.text()
        if (!res.ok) return fail(`HTTP ${res.status} ${res.statusText} for ${url}\n${raw.slice(0, 500)}`)
        const text = /html/i.test(contentType) ? htmlToText(raw) : raw
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim()
        return ok(
          `URL: ${url}\nStatus: ${res.status}${title ? `\nTitle: ${htmlToText(title)}` : ''}\nContent-Type: ${contentType}\n\n${text.slice(0, maxChars)}${
            text.length > maxChars ? `\n\n[truncated ${text.length - maxChars} characters]` : ''
          }`,
          { url, status: res.status, bytes: raw.length }
        )
      } catch (err) {
        return fail(`Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  },
  {
    name: 'web.search',
    description:
      'Search the web (DuckDuckGo HTML) and return titles, URLs and snippets. Follow up with web.fetch for the useful pages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', description: 'Default 8, max 15.' }
      },
      required: ['query']
    },
    risk: 'low',
    category: 'web',
    group: 'web',
    source: 'builtin',
    enabled: () => !settings.get().privacy.localOnly,
    preview: (args) => `Search the web for "${String(args.query)}"`,
    handler: async (args) => {
      const blocked = localOnly()
      if (blocked) return fail(blocked)
      const query = requireString(args, 'query')
      try {
        const results = await searchWeb(query, Math.min(num(args.maxResults, 8), 15))
        if (!results.length) return ok(`No results parsed for "${query}". Try a more specific query or use web.fetch with a known URL.`)
        recordActivity('web', `Searched the web: ${query}`)
        return ok(
          `Search results for "${query}" (DuckDuckGo):\n\n${results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
            .join('\n\n')}\n\nThis information came from the internet. Verify critical details against the page contents.`,
          results
        )
      } catch (err) {
        return fail(`Web search failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
]
