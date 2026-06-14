import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard render error', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="panel-card max-w-xl rounded-[var(--radius-shell)] p-6 shadow-sm">
          <p className="text-sm font-medium text-destructive">Dashboard crashed before it could finish rendering.</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">Reload LLMHarbor</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The router is probably still running, but the UI hit a client-side error. Reload the dashboard; if it happens again, copy the message below.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-2xl bg-muted p-3 text-xs text-muted-foreground">
            {this.state.error.message}
          </pre>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => window.location.reload()}>Reload dashboard</Button>
            <Button variant="outline" onClick={() => { window.location.href = `${import.meta.env.BASE_URL || '/'}playground` }}>Go to Playground</Button>
          </div>
        </div>
      </div>
    )
  }
}
