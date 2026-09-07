import { useState } from 'react'
import type { Model } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineNotice } from '@/components/status-indicator'

export type ModelSettings = Pick<Model, 'displayName' | 'contextWindow' | 'rpmLimit' | 'rpdLimit' | 'tpmLimit' | 'tpdLimit'>
const limits = [
  ['contextWindow', 'Context window'], ['rpmLimit', 'Requests / minute'], ['rpdLimit', 'Requests / day'],
  ['tpmLimit', 'Tokens / minute'], ['tpdLimit', 'Tokens / day'],
] as const

export function ModelEditor({ model, busy, onSave, onCancel }: {
  model: ModelSettings & { id: number }
  busy: boolean
  onSave: (settings: Partial<ModelSettings>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(model.displayName)
  const [values, setValues] = useState(() => Object.fromEntries(limits.map(([field]) => [field, model[field]?.toString() ?? ''])))
  const [error, setError] = useState<string | null>(null)
  return (
    <form className="mt-3 space-y-3 border-t border-border pt-3" aria-label={`Edit ${model.displayName}`} onSubmit={event => {
      event.preventDefault()
      const patch: Partial<ModelSettings> = {}
      if (!name.trim()) { setError('A display name is required.'); return }
      if (name.trim() !== model.displayName) patch.displayName = name.trim()
      for (const [field, label] of limits) {
        const value = values[field].trim() ? Number(values[field]) : null
        if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) { setError(`${label} must be a positive whole number, or blank.`); return }
        if (value !== model[field]) patch[field] = value
      }
      if (!Object.keys(patch).length) { onCancel(); return }
      setError(null)
      onSave(patch)
    }}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`model-name-${model.id}`} className="text-xs">Display name</Label>
          <Input id={`model-name-${model.id}`} value={name} onChange={event => setName(event.target.value)} maxLength={160} required disabled={busy} />
        </div>
        {limits.map(([field, label]) => (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={`model-${field}-${model.id}`} className="text-xs">{label}</Label>
            <Input id={`model-${field}-${model.id}`} type="number" min={1} step={1} value={values[field]} disabled={busy}
              placeholder={field === 'contextWindow' ? 'Unknown' : 'Unlimited'}
              onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} />
          </div>
        ))}
      </div>
      {error ? <InlineNotice tone="critical">{error}</InlineNotice> : null}
      <p className="text-xs text-muted-foreground">Request and token quotas apply to each credential. Blank removes a quota. Context window is catalog metadata; the upstream enforces its context limit.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save model'}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
