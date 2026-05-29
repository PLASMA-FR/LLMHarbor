import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { HarborLogo } from '@/components/harbor-logo'
import KeysPage from '@/pages/KeysPage'
import PlaygroundPage from '@/pages/PlaygroundPage'
import FallbackPage from '@/pages/FallbackPage'
import ModelsPage from '@/pages/ModelsPage'
import AnalyticsPage from '@/pages/AnalyticsPage'
import OAuthPage from '@/pages/OAuthPage'
import SettingsPage from '@/pages/SettingsPage'
import { cn } from '@/lib/utils'

const queryClient = new QueryClient()

const navItems = [
  { to: '/playground', label: 'Playground', helper: 'test routes' },
  { to: '/keys', label: 'Keys', helper: 'credentials' },
  { to: '/oauth', label: 'OAuth', helper: 'accounts' },
  { to: '/models', label: 'Models', helper: 'registry' },
  { to: '/fallback', label: 'Fallback', helper: 'model chain' },
  { to: '/analytics', label: 'Analytics', helper: 'traffic' },
  { to: '/settings', label: 'Settings', helper: 'endpoints' },
]

function NavItem({ to, label, helper }: { to: string; label: string; helper: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          'group flex min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5 text-sm transition-all',
          isActive
            ? 'bg-muted text-foreground ring-1 ring-border'
            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className={cn('h-4 w-1 rounded-sm transition-colors', isActive ? 'bg-primary' : 'bg-border group-hover:bg-muted-foreground/50')} />
          <span className="min-w-0">
            <span className="block leading-4">{label}</span>
            <span className="hidden text-[10px] leading-3 text-muted-foreground lg:block">{helper}</span>
          </span>
        </>
      )}
    </NavLink>
  )
}

function DarkModeToggle() {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const stored = localStorage.getItem('theme')
    const next = stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }, [])

  function toggle() {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  return (
    <Button variant="outline" size="icon-sm" onClick={toggle} aria-label="Toggle theme" className="rounded-[var(--radius-button)] bg-card">
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      )}
    </Button>
  )
}

function AppShell() {
  return (
    <div className="min-h-screen overflow-hidden bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl items-center gap-5 px-4 py-3 sm:px-6 lg:px-8">
          <NavLink to="/playground" className="rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
            <HarborLogo showWordmark />
          </NavLink>
          <nav className="ml-auto hidden items-center gap-1 md:flex">
            {navItems.map(item => <NavItem key={item.to} {...item} />)}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-2">
            <div className="hidden rounded-lg border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground sm:block">
              Local router, OpenAI compatible
            </div>
            <DarkModeToggle />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-4 pb-3 md:hidden">
          {navItems.map(item => <NavItem key={item.to} {...item} />)}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
        <Routes>
          <Route path="/" element={<Navigate to="/playground" replace />} />
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
          <Route path="/health" element={<Navigate to="/keys" replace />} />
        </Routes>
      </main>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AppShell />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App

