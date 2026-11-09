import { useEffect, useMemo, useRef } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { Icon } from './Icons'

marked.setOptions({
  gfm: true,
  breaks: true
})

interface Props {
  content: string
  className?: string
}

export function Markdown({ content, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const raw = marked.parse(content ?? '') as string
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onclick', 'onload']
    })
  }, [content])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('a').forEach((link) => {
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noreferrer noopener')
    })
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('codeblock')) return
      const wrapper = document.createElement('div')
      wrapper.className = 'codeblock'
      const head = document.createElement('div')
      head.className = 'code-head'
      const code = pre.querySelector('code')
      const language =
        code?.className
          .split(/\s+/)
          .find((c) => c.startsWith('language-'))
          ?.replace('language-', '') ||
        code?.className.split(/\s+/).find((c) => c.startsWith('hljs-')) ||
        'code'
      const label = document.createElement('span')
      label.textContent = String(language).replace('language-', '')
      const button = document.createElement('button')
      button.className = 'copy-code'
      button.type = 'button'
      button.innerHTML = 'Copy'
      button.addEventListener('click', () => {
        const text = code?.textContent ?? pre.textContent ?? ''
        void navigator.clipboard.writeText(text)
        button.textContent = 'Copied'
        setTimeout(() => {
          button.textContent = 'Copy'
        }, 1400)
      })
      head.appendChild(label)
      head.appendChild(button)
      pre.parentNode?.insertBefore(wrapper, pre)
      wrapper.appendChild(head)
      wrapper.appendChild(pre)
    })
    root.querySelectorAll('pre code').forEach((el) => {
      if (el.classList.contains('hljs')) return
      try {
        hljs.highlightElement(el as HTMLElement)
      } catch {
        // unknown language — leave plain
      }
    })
  }, [html])

  if (!content) return null

  return (
    <div
      ref={ref}
      className={`markdown ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button
      className="mini-btn"
      type="button"
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
      }}
    >
      <Icon name="copy" size={12} />
    </button>
  )
}
