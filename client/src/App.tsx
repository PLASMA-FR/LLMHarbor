import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  createBrowserRouter,
  Navigate,
  NavLink,
  Routes,
  Route,
  RouterProvider,
  useLocation,
} from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Menu, Moon, Sun, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { AppErrorBoundary } from '@/components/app-error-boundary'
import { FeedbackProvider } from '@/components/feedback-provider'
import { CommandMenu } from '@/components/command-menu'
import { HarborLogo } from '@/components/harbor-logo'
import { LoadingState } from '@/components/page-header'
import { ApiError, apiFetch } from '@/lib/api'
import { notify } from '@/lib/feedback'
import { cn } from '@/lib/utils'
import { navGroups, navItems } from '@/lib/navigation'
import { createPlaygroundDraft, PlaygroundContext } from '@/lib/playground-state'

const OverviewPage = lazy(() => import('@/pages/OverviewPage'))
const KeysPage = lazy(() => import('@/pages/ProvidersPage'))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage'))
const FallbackPage = lazy(() => import('@/pages/RoutingPage'))
const ModelsPage = lazy(() => import('@/pages/ModelCatalogPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))
const OAuthPage = lazy(() => import('@/pages/OAuthPage'))
const SettingsPage = lazy(() => import('@/pages/InstanceSettingsPage'))
const ClientAccessPage = lazy(() => import('@/pages/ClientAccessPage'))
const ApiGuidePage = lazy(() => import('@/pages/ApiGuidePage'))

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: (_data, _variables, _context, mutation) => {
      if (typeof mutation.meta?.successMessage === 'string') notify(mutation.meta.successMessage)
    },
    onError: (error) =>
      notify(
        error instanceof ApiError && error.fieldErrors.length
          ? 'Some fields need attention. Review the form and try again.'
          : error.message,
        'error',
        error instanceof ApiError ? error.requestId : undefined,
      ),
  }),
  defaultOptions: {
    queries: {
      networkMode: 'always',
      staleTime: 15_000,
      retry: (count, error) =>
        count < 1 &&
        (!(error instanceof ApiError) ||
          error.status === 0 ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500),
      refetchOnWindowFocus: true,
    },
    mutations: { retry: 0, networkMode: 'always' },
  },
})

function initialDarkMode() {
  try {
    const theme = localStorage.getItem('theme')
    return theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    return matchMedia('(prefers-color-scheme: dark)').matches
  }
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="space-y-5" aria-label="Primary navigation">
      {navGroups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {group.label}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                title={item.helper}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}

function ServiceStatus() {
  const health = useQuery<{ keys: Array<{ enabled: boolean; status: string }> }>({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiFetch('/api/health', { signal }),
    refetchInterval: 30_000,
  })
  const enabled = health.data?.keys.filter((key) => key.enabled) ?? []
  const issues = enabled.filter((key) => ['invalid', 'error', 'rate_limited'].includes(key.status)).length
  return (
    <div className="rounded-xl border border-border bg-background p-3 text-xs" role="status">
      <p className="flex items-center gap-2 font-medium">
        <span
          className={cn(
            'size-1.5 rounded-full',
            health.isError
              ? 'bg-destructive'
              : issues
                ? 'bg-amber-500'
                : health.isLoading
                  ? 'bg-muted-foreground'
                  : 'bg-primary',
          )}
          aria-hidden="true"
        />
        {health.isError ? 'Connection unavailable' : health.isLoading ? 'Connecting…' : 'Gateway online'}
      </p>
      <p className="mt-1.5 text-muted-foreground">
        {health.isError
          ? 'Check the server connection.'
          : issues
            ? issues + ' enabled credentials need attention'
            : enabled.length + ' enabled credentials'}
      </p>
    </div>
  )
}

function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation()
  return <Navigate to={to + location.search + location.hash} replace />
}

function AppShell() {
  const location = useLocation()
  const [dark, setDark] = useState(initialDarkMode)
  const [mobileOpen, setMobileOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const initial = useRef(true)
  const pathname = location.pathname.replace(/\/+$/, '') || '/overview'
  const currentPage =
    navItems.find((item) => item.to === pathname)?.label ??
    (pathname === '/keys' ? 'Providers' : 'Page not found')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light')
    } catch {
      /* preference applies until reload */
    }
  }, [dark])
  useEffect(() => {
    document.title = currentPage + ' · LLMHarbor'
    if (initial.current) {
      initial.current = false
      return
    }
    window.scrollTo(0, 0)
    mainRef.current?.focus({ preventScroll: true })
  }, [currentPage, location.pathname])
  return (
    <div className="min-h-screen min-w-0 lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <aside
        className="sticky top-0 hidden h-dvh flex-col gap-7 overflow-y-auto border-r border-sidebar-border bg-sidebar p-4 lg:flex"
        aria-label="Application sidebar"
      >
        <NavLink
          to="/overview"
          aria-label="LLMHarbor overview"
          className="rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HarborLogo showWordmark />
        </NavLink>
        <Navigation />
        <div className="mt-auto space-y-3">
          <ServiceStatus />
          <NavLink
            to="/api-guide"
            className="flex items-center justify-between px-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Integrate your first app
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </NavLink>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-border bg-background px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              className="lg:hidden"
              size="icon-sm"
              variant="ghost"
              aria-label="Open navigation"
              aria-haspopup="dialog"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <Menu aria-hidden="true" />
            </Button>
            <p className="truncate text-sm">
              <span className="hidden text-muted-foreground sm:inline">
                Workspace <span className="mx-2 opacity-50">/</span>
              </span>
              <span className="font-medium">{currentPage}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CommandMenu />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDark((value) => !value)}
              aria-pressed={dark}
              aria-label="Dark theme"
              title={dark ? 'Use light theme' : 'Use dark theme'}
            >
              {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </Button>
          </div>
        </header>
        <Modal
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          title="Navigation"
          description="LLMHarbor workspace"
          sheet
        >
          <Navigation onNavigate={() => setMobileOpen(false)} />
        </Modal>
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {currentPage} page
        </div>
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="mx-auto min-w-0 max-w-[1480px] px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8"
        >
          <Suspense fallback={<LoadingState title="Loading workspace" description="Preparing this page…" />}>
            <Routes>
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/providers" element={<KeysPage />} />
              <Route path="/keys" element={<LegacyRedirect to="/providers" />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/fallback" element={<FallbackPage />} />
              <Route path="/oauth" element={<OAuthPage />} />
              <Route path="/access" element={<ClientAccessPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/api-guide" element={<ApiGuidePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/image" element={<Navigate to="/api-guide" replace />} />
              <Route path="/audio" element={<Navigate to="/api-guide" replace />} />
              <Route path="/test" element={<Navigate to="/playground" replace />} />
              <Route path="/health" element={<Navigate to="/overview" replace />} />
              <Route
                path="*"
                element={
                  <div className="panel-card mx-auto max-w-xl rounded-2xl p-8 text-center">
                    <p className="text-xs text-muted-foreground">404 · Page not found</p>
                    <h1 className="mt-2 text-2xl font-semibold">This page has moved or doesn’t exist.</h1>
                    <NavLink to="/overview" className="mt-5 inline-block text-sm text-primary underline">
                      Return to Overview
                    </NavLink>
                  </div>
                }
              />
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
const router = createBrowserRouter(
  [
    {
      path: '*',
      element: (
        <AppErrorBoundary>
          <AppShell />
        </AppErrorBoundary>
      ),
    },
  ],
  { basename: import.meta.env.BASE_URL },
)
export default function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <FeedbackProvider>
          <PlaygroundDraftProvider>
            <RouterProvider router={router} />
          </PlaygroundDraftProvider>
        </FeedbackProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  )
}
