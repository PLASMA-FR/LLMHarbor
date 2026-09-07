import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'
import { notify } from '@/lib/feedback'

export function CodeBlock({
  code,
  label,
  secret = false,
}: {
  code: string
  label: string
  secret?: boolean
}) {
  const [copiedCode, setCopied] = useState<string | null>(null)
  const copied = copiedCode === code
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-muted/35">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await copyText(code)
              setCopied(code)
              notify(secret ? 'Key copied. Store it somewhere safe.' : `${label} copied.`)
            } catch (error) {
              notify(error instanceof Error ? error.message : 'Copy failed.', 'error')
            }
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className="overflow-auto p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <code className={secret ? 'select-all' : undefined}>{code}</code>
      </pre>
    </div>
  )
}
