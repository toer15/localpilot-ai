export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`
}

export function formatNumber(n?: number): string {
  if (n === undefined || n === null) return '—'
  return new Intl.NumberFormat('en', { notation: n > 9999 ? 'compact' : 'standard' }).format(n)
}

export function relativeTime(iso?: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return 'just now'
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`
  if (diff < day) return `${Math.floor(diff / hour)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function fullDate(iso?: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function initials(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
}

export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function providerLabel(id?: string | null): string {
  switch (id) {
    case 'ollama':
      return 'Ollama'
    case 'lmstudio':
      return 'LM Studio'
    case 'llamacpp':
      return 'llama.cpp'
    default:
      return id ?? 'Local'
  }
}

export function isImagePath(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
}

export function groupConversations<T extends { updatedAt: string }>(items: T[]): { label: string; items: T[] }[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const groups: { label: string; items: T[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] }
  ]
  for (const item of items) {
    const time = new Date(item.updatedAt).getTime()
    if (time >= startOfToday) groups[0].items.push(item)
    else if (time >= startOfToday - day) groups[1].items.push(item)
    else if (time >= startOfToday - 7 * day) groups[2].items.push(item)
    else groups[3].items.push(item)
  }
  return groups.filter((g) => g.items.length)
}
