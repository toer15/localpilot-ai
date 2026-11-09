import type { ModelCatalogItem } from '@shared/types'
import { fetchJson } from '../providers/http'
import { inferredCapabilities } from '../providers/types'
import { getSecret } from '../secrets'

interface HfModel {
  id: string
  author?: string
  downloads?: number
  likes?: number
  tags?: string[]
  lastModified?: string
  gated?: boolean
}

const cache = new Map<string, { at: number; items: ModelCatalogItem[] }>()

function hfHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getSecret('huggingface')
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export async function searchHuggingFace(query: string): Promise<ModelCatalogItem[]> {
  const key = `hf:${query}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < 60000) return cached.items
  const params = new URLSearchParams({
    search: query || 'gguf',
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: '30',
    full: 'false'
  })
  const models = await fetchJson<HfModel[]>(`https://huggingface.co/api/models?${params.toString()}`, {
    timeoutMs: 20000,
    headers: hfHeaders()
  })
  const items = (models ?? []).map((model) => {
    const tags = model.tags ?? []
    const inferred = inferredCapabilities(`${model.id} ${tags.join(' ')}`)
    const isVision = tags.some((t) => /image-text-to-text|vision|multimodal/i.test(t)) || inferred.vision
    const tools = tags.some((t) => /tool|function-calling/i.test(t)) || inferred.tools
    return {
      id: model.id,
      name: model.id,
      developer: model.author ?? model.id.split('/')[0] ?? 'Community',
      description: `GGUF repository · ${tags.slice(0, 6).join(', ') || 'quantized weights'}`,
      tags,
      downloads: model.downloads,
      likes: model.likes,
      updatedAt: model.lastModified,
      source: 'huggingface' as const,
      gated: Boolean(model.gated),
      capabilities: { ...inferred, vision: isVision, tools, embeddings: false },
      capabilitySource: 'inferred' as const,
      files: []
    }
  })
  cache.set(key, { at: Date.now(), items })
  return items
}

interface CuratedGguf {
  repo: string
  name: string
  developer: string
  description: string
  tags: string[]
  capabilities: { tools: boolean; vision: boolean; thinking: boolean }
}

/** Ready-to-download GGUF repositories that run in LocalPilot's managed llama.cpp engine. */
const CURATED_GGUF: CuratedGguf[] = [
  {
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    name: 'Qwen2.5 0.5B Instruct',
    developer: 'Alibaba Qwen',
    description: 'Tiny, fast starter model for testing local inference on modest hardware.',
    tags: ['small', 'fast', 'qwen'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    name: 'Qwen2.5 3B Instruct',
    developer: 'Alibaba Qwen',
    description: 'Balanced 3B assistant with strong writing, coding and tool use for 8GB machines.',
    tags: ['recommended', 'tools', '3b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    name: 'Qwen2.5 Coder 7B',
    developer: 'Alibaba Qwen',
    description: 'Code generation and editing specialist that fits on a 12GB GPU at Q4.',
    tags: ['coding', 'tools', '7b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    name: 'Llama 3.2 3B Instruct',
    developer: 'Meta',
    description: 'Compact general assistant with reliable instruction following and tool support.',
    tags: ['recommended', 'tools', '3b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    name: 'Llama 3.1 8B Instruct',
    developer: 'Meta',
    description: 'Well-established 8B local assistant with broad tool and reasoning coverage.',
    tags: ['tools', '8b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF',
    name: 'DeepSeek R1 Distill 7B',
    developer: 'DeepSeek',
    description: 'Reasoning-focused 7B distill for step-by-step math and logic.',
    tags: ['reasoning', '7b'],
    capabilities: { tools: false, vision: false, thinking: true }
  },
  {
    repo: 'bartowski/gemma-2-9b-it-GGUF',
    name: 'Gemma 2 9B Instruct',
    developer: 'Google',
    description: 'Strong general-purpose assistant with a compact 9B footprint.',
    tags: ['general', '9b'],
    capabilities: { tools: false, vision: false, thinking: false }
  },
  {
    repo: 'bartowski/Mistral-Nemo-Instruct-2407-GGUF',
    name: 'Mistral Nemo 12B Instruct',
    developer: 'Mistral AI',
    description: 'Larger all-round model with multilingual support and tool calling.',
    tags: ['tools', '12b'],
    capabilities: { tools: true, vision: false, thinking: false }
  }
]

function curatedGguf(query: string): ModelCatalogItem[] {
  const q = query.trim().toLowerCase()
  return CURATED_GGUF.filter(
    (model) =>
      !q ||
      model.name.toLowerCase().includes(q) ||
      model.repo.toLowerCase().includes(q) ||
      model.developer.toLowerCase().includes(q) ||
      model.tags.some((tag) => tag.includes(q))
  ).map((model) => ({
    id: model.repo,
    name: model.name,
    developer: model.developer,
    description: model.description,
    tags: model.tags,
    source: 'curated' as const,
    capabilities: {
      ...model.capabilities,
      completion: true,
      embeddings: false
    },
    capabilitySource: 'inferred' as const,
    files: []
  }))
}

interface CuratedOllama {
  pullName: string
  developer: string
  description: string
  tags: string[]
  capabilities: { tools: boolean; vision: boolean; thinking: boolean }
}

/** Curated, real Ollama pullable models. Capabilities reflect the published model families. */
const CURATED_OLLAMA: CuratedOllama[] = [
  {
    pullName: 'qwen3:8b',
    developer: 'Alibaba Qwen',
    description: 'Qwen3 8B — strong reasoning, coding and native tool calling, thinking mode.',
    tags: ['reasoning', 'tools', '8b'],
    capabilities: { tools: true, vision: false, thinking: true }
  },
  {
    pullName: 'qwen3:30b-a3b',
    developer: 'Alibaba Qwen',
    description: 'Qwen3 30B A3B MoE — fast, capable reasoning with ~3B active parameters.',
    tags: ['moe', 'tools', '30b'],
    capabilities: { tools: true, vision: false, thinking: true }
  },
  {
    pullName: 'qwen2.5-coder:14b',
    developer: 'Alibaba Qwen',
    description: 'Qwen2.5 Coder 14B — code generation and editing specialist.',
    tags: ['coding', 'tools', '14b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    pullName: 'llama3.2:3b',
    developer: 'Meta',
    description: 'Llama 3.2 3B — compact general assistant with tool support.',
    tags: ['tools', '3b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    pullName: 'gemma3:12b',
    developer: 'Google',
    description: 'Gemma 3 12B — strong general performance with vision support.',
    tags: ['vision', '12b'],
    capabilities: { tools: true, vision: true, thinking: false }
  },
  {
    pullName: 'deepseek-r1:14b',
    developer: 'DeepSeek',
    description: 'DeepSeek R1 distill 14B — extended reasoning chains.',
    tags: ['reasoning', '14b'],
    capabilities: { tools: false, vision: false, thinking: true }
  },
  {
    pullName: 'mistral-nemo:12b',
    developer: 'Mistral AI',
    description: 'Mistral Nemo 12B — reliable general model with tool calling.',
    tags: ['tools', '12b'],
    capabilities: { tools: true, vision: false, thinking: false }
  },
  {
    pullName: 'llama3.1:8b',
    developer: 'Meta',
    description: 'Llama 3.1 8B — well-established local assistant with tool support.',
    tags: ['tools', '8b'],
    capabilities: { tools: true, vision: false, thinking: false }
  }
]

function curatedOllama(query: string): ModelCatalogItem[] {
  const q = query.trim().toLowerCase()
  return CURATED_OLLAMA.filter(
    (m) =>
      !q ||
      m.pullName.includes(q) ||
      m.developer.toLowerCase().includes(q) ||
      m.tags.some((t) => t.includes(q))
  ).map((model) => ({
    id: `ollama:${model.pullName}`,
    name: model.pullName,
    developer: model.developer,
    description: model.description,
    tags: model.tags,
    source: 'curated' as const,
    capabilities: {
      ...model.capabilities,
      completion: true,
      embeddings: false
    },
    capabilitySource: 'inferred' as const,
    pullName: model.pullName
  }))
}

/** Real Ollama library search via the public website; falls back to the curated list. */
export async function searchOllama(query: string): Promise<ModelCatalogItem[]> {
  const key = `ollama:${query}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < 60000) return cached.items
  try {
    const res = await fetch(`https://ollama.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'LocalPilotAI/0.1' },
      signal: AbortSignal.timeout(12000)
    })
    if (!res.ok) throw new Error(String(res.status))
    const html = await res.text()
    const found = new Map<string, ModelCatalogItem>()
    const linkRe = /href="\/library\/([^"?#/]+)"[^>]*>([\s\S]{0,220}?)<\/a>/g
    let match: RegExpExecArray | null
    while ((match = linkRe.exec(html))) {
      const name = decodeURIComponent(match[1])
      if (!name || found.has(name) || name.length > 80) continue
      const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const descMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(match[2])
      const description = (descMatch?.[1] ?? text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const inferred = inferredCapabilities(name)
      found.set(name, {
        id: `ollama:${name}`,
        name,
        developer: 'Ollama library',
        description: description || 'Model from the Ollama library',
        tags: [],
        source: 'ollama',
        capabilities: { ...inferred, completion: true, embeddings: false },
        capabilitySource: 'inferred',
        pullName: `${name}:latest`
      })
    }
    if (found.size) {
      const items = [...found.values()].slice(0, 24)
      cache.set(key, { at: Date.now(), items })
      return items
    }
    throw new Error('No results parsed')
  } catch {
    return curatedOllama(query)
  }
}

export async function catalogSearch(
  query: string,
  source: 'curated' | 'huggingface' | 'ollama' = 'curated'
): Promise<ModelCatalogItem[]> {
  if (source === 'curated') return curatedGguf(query)
  try {
    if (source === 'ollama') return await searchOllama(query)
    return await searchHuggingFace(query)
  } catch {
    if (source === 'huggingface') return curatedGguf(query)
    return []
  }
}
