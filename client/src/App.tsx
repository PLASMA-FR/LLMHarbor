import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter, Navigate, NavLink, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  Boxes,
  ChartNoAxesColumn,
  KeyRound,
  LayoutDashboard,
  MessageSquareCode,
  Moon,
  Route as RouteIcon,
  Settings2,
  ShieldCheck,
  Sun,
  type LucideProps,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppErrorBoundary } from '@/components/app-error-boundary'
import { HarborLogo } from '@/components/harbor-logo'
import { LoadingState } from '@/components/page-header'
import { ApiError, apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { createPlaygroundDraft, PlaygroundContext } from '@/lib/playground-state'

const OverviewPage = lazy(() => import('@/pages/OverviewPage'))
const KeysPage = lazy(() => import('@/pages/KeysPage'))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage'))
const FallbackPage = lazy(() => import('@/pages/FallbackPage'))
const ModelsPage = lazy(() => import('@/pages/ModelsPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))
const OAuthPage = lazy(() => import('@/pages/OAuthPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (failureCount, error) => {
        if (failureCount >= 1) return false
        if (!(error instanceof ApiError)) return true
        return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
})

type Icon = ComponentType<LucideProps>

interface NavItemDefinition {
  to: string
  label: string
  helper: string
  icon: Icon
}

const navGroups: Array<{ label: string; items: NavItemDefinition[] }> = [
  {
    label: 'Workspace',
    items: [
      { to: '/overview', label: 'Overview', helper: 'service health', icon: LayoutDashboard },
      { to: '/playground', label: 'Playground', helper: 'test requests', icon: MessageSquareCode },
    ],
  },
  {
    label: 'Control plane',
    items: [
      { to: '/keys', label: 'Providers & keys', helper: 'credentials', icon: KeyRound },
      { to: '/models', label: 'Models', helper: 'catalog', icon: Boxes },
      { to: '/fallback', label: 'Routing', helper: 'fallback order', icon: RouteIcon },
      { to: '/oauth', label: 'OAuth accounts', helper: 'connected capacity', icon: ShieldCheck },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/analytics', label: 'Analytics', helper: 'traffic & failures', icon: ChartNoAxesColumn },
      { to: '/settings', label: 'Settings', helper: 'policies & backup', icon: Settings2 },
    ],
  },
]

const allNavItems = navGroups.flatMap(group => group.items)

function getInitialDarkMode() {
  if (typeof window === 'undefined') return false
  try {
    const stored = localStorage.getItem('theme')
    return stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
}

function NavItem({ item, compact = false }: { item: NavItemDefinition; compact?: boolean }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => cn(
        'group flex min-w-0 items-center gap-2.5 rounded-[var(--radius-button)] text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30',
        compact ? 'shrink-0 px-3 py-2' : 'w-full px-2.5 py-2',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
      )}
    >
      {({ isActive }) => (
        <>
          <Icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate leading-5">{item.label}</span>
            {!compact ? (
              <span className={cn(
                'block truncate text-[10px] font-normal leading-3.5',
                isActive ? 'text-sidebar-foreground/80' : 'text-muted-foreground',
              )}>{item.helper}</span>
            ) : null}
          </span>
        </>
      )}
    </NavLink>
  )
}

function DarkModeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onToggle}
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? 'Use light theme' : 'Use dark theme'}
    >
      {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  )
}

interface HealthSummary {
  platforms: Array<{ enabledKeys: number; healthyKeys: number; errorKeys: number; invalidKeys: number; rateLimitedKeys: number }>
}

function ServiceStatus() {
  const health = useQuery<HealthSummary>({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiFetch('/api/health', { signal }),
    refetchInterval: 30_000,
  })
  const enabled = health.data?.platforms.reduce((sum, platform) => sum + platform.enabledKeys, 0) ?? 0
  const issues = health.data?.platforms.reduce((sum, platform) => sum + platform.errorKeys + platform.invalidKeys + platform.rateLimitedKeys, 0) ?? 0
  const tone = health.isError ? 'bg-destructive' : health.isLoading ? 'bg-muted-foreground/50' : issues > 0 ? 'bg-amber-500' : 'bg-emerald-500'
  const label = health.isError ? 'Dashboard API unavailable' : health.isLoading ? 'Checking service' : issues > 0 ? `${issues} credential issue${issues === 1 ? '' : 's'}` : `${enabled} enabled credential${enabled === 1 ? '' : 's'}`

  return (
    <div className="rounded-[var(--radius-panel)] border border-sidebar-border bg-background/70 px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className={cn('size-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
        <span>{health.isError ? 'Connection issue' : health.isLoading ? 'Checking service' : 'Service online'}</span>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">{label}</p>
    </div>
  )
}

function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="panel-card mx-auto max-w-xl rounded-[var(--radius-shell)] p-8 text-center">
      <p className="text-sm font-medium text-muted-foreground">404 · Page not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-[-0.035em]">That dashboard page doesn’t exist.</h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Use the navigation to return to the control plane.</p>
      <Button className="mt-5" onClick={() => navigate('/overview')}>Open overview</Button>
    </div>
  )
}

function PageFallback() {
  return <LoadingState title="Loading dashboard" description="Preparing this workspace…" />
}

function AppShell() {
  const location = useLocation()
  const [dark, setDark] = useState(getInitialDarkMode)
  const mainRef = useRef<HTMLElement | null>(null)
  const firstRoute = useRef(true)
  const normalizedPath = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname
  const currentPage = allNavItems.find(item => item.to === normalizedPath)?.label ?? 'Page not found'

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light')
    } catch {
      // Theme choice remains active for this page when storage is unavailable.
    }
  }, [dark])

  useEffect(() => {
    document.title = `${currentPage} · LLMHarbor`
    if (firstRoute.current) {
      firstRoute.current = false
      return
    }
    window.scrollTo(0, 0)
    mainRef.current?.focus({ preventScroll: true })
  }, [currentPage, location.pathname])

  return (
    <div className="min-h-screen min-w-0 bg-background text-foreground lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#main-content" className="skip-link">Skip to main content</a>

      <aside className="sticky top-0 hidden h-screen overflow-y-auto border-r border-sidebar-border bg-sidebar px-3 py-4 lg:flex lg:flex-col" aria-label="Application sidebar">
        <NavLink to="/overview" className="mx-1 rounded-[var(--radius-button)] outline-none focus-visible:ring-3 focus-visible:ring-ring/30" aria-label="LLMHarbor overview">
          <HarborLogo showWordmark />
        </NavLink>
        <nav className="mt-7 flex-1 space-y-5" aria-label="Primary navigation">
          {navGroups.map(group => (
            <div key={group.label}>
              <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => <NavItem key={item.to} item={item} />)}
              </div>
            </div>
          ))}
        </nav>
        <div className="space-y-2">
          <ServiceStatus />
          <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
            <span>OpenAI-compatible /v1</span>
            <DarkModeToggle dark={dark} onToggle={() => setDark(value => !value)} />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-40 border-b border-border bg-background/95 lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
            <NavLink to="/overview" className="rounded-[var(--radius-button)] outline-none focus-visible:ring-3 focus-visible:ring-ring/30" aria-label="LLMHarbor overview">
              <HarborLogo showWordmark />
            </NavLink>
            <DarkModeToggle dark={dark} onToggle={() => setDark(value => !value)} />
          </div>
          <nav className="nav-scroll flex gap-1 overflow-x-auto overscroll-x-contain px-3 pb-2.5 sm:px-5" aria-label="Primary navigation">
            {allNavItems.map(item => <NavItem key={item.to} item={item} compact />)}
          </nav>
        </header>

        <div className="sr-only" aria-live="polite" aria-atomic="true">{currentPage} page</div>
        <main ref={mainRef} id="main-content" tabIndex={-1} className="mx-auto box-border min-w-0 max-w-[1480px] px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8 xl:px-10">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/keys" element={<KeysPage />} />
              <Route path="/image" element={<Navigate to="/settings" replace />} />
              <Route path="/audio" element={<Navigate to="/settings" replace />} />
              <Route path="/oauth" element={<OAuthPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/fallback" element={<FallbackPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/test" element={<Navigate to="/playground" replace />} />
              <Route path="/health" element={<Navigate to="/overview" replace />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  )
}

function PlaygroundDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(createPlaygroundDraft)
  return <PlaygroundContext value={{ draft, setDraft }}>{children}</PlaygroundContext>
}

function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <PlaygroundDraftProvider><AppShell /></PlaygroundDraftProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  )
}

export default App
