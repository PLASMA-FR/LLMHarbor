import { cn } from '@/lib/utils'

export function HarborLogo({ className, showWordmark = false }: { className?: string; showWordmark?: boolean }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <svg className="size-10 shrink-0" viewBox="0 0 72 72" role="img" aria-label="LLMHarbor anchor logo">
        <rect x="4" y="4" width="64" height="64" rx="14" fill="#F4F6F3" />
        <rect x="4.5" y="4.5" width="63" height="63" rx="13.5" fill="none" stroke="#D7DED8" />
        <path d="M18 46c4.4 7.8 10.4 11.7 18 11.7S49.6 53.8 54 46" fill="none" stroke="#D7DED8" strokeWidth="7" strokeLinecap="round" />
        <g fill="none" stroke="#1C5F58" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="36" cy="17" r="5.75" strokeWidth="4.8" />
          <path d="M36 22.8v31.2" strokeWidth="4.8" />
          <path d="M25 32h22" strokeWidth="4.8" />
          <path d="M18.5 45.5c4 7.7 9.85 11.55 17.5 11.55S49.5 53.2 53.5 45.5" strokeWidth="4.8" />
          <path d="M18.5 45.5l10.2-2" strokeWidth="4.8" />
          <path d="M53.5 45.5l-10.2-2" strokeWidth="4.8" />
        </g>
        <path d="M42 29h7.8l-6.1 7.4h7.1" fill="none" stroke="#8B6B22" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {showWordmark && (
        <div className="leading-none">
          <span className="block text-[15px] font-semibold tracking-[-0.02em]">LLMHarbor</span>
          <span className="mt-1 block text-[10px] font-medium text-muted-foreground">Local LLM routing</span>
        </div>
      )}
    </div>
  )
}
