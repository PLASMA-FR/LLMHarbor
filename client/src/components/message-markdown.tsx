import { Children, isValidElement, memo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/code-block'

function FencedCode({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0]
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>
  const language = child.props.className?.match(/language-([a-z0-9_+-]{1,32})/i)?.[1]
  return (
    <CodeBlock
      code={String(child.props.children ?? '').replace(/\n$/, '')}
      label={language ? `Code · ${language}` : 'Code'}
    />
  )
}

// HTML is never executed, images never fetch remote URLs, and links use the
// library's safe URL transform. The raw response remains available in Plain text.
export default memo(function MessageMarkdown({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: FencedCode,
          img: ({ alt }) => <span className="text-muted-foreground">[{alt || 'Image'}]</span>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {children}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  )
})
