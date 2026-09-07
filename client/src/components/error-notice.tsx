import { ApiError, getErrorMessage } from '@/lib/api'
import { InlineNotice } from '@/components/status-indicator'

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  const apiError = error instanceof ApiError ? error : null
  return (
    <InlineNotice tone="critical">
      <p>{apiError?.fieldErrors.length ? 'Check these fields and try again.' : getErrorMessage(error)}</p>
      {apiError?.fieldErrors.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {apiError.fieldErrors.map((detail, index) => (
            <li key={`${detail.path}:${index}`}>
              <span className="font-medium">{detail.path}</span>: {detail.message}
            </li>
          ))}
        </ul>
      ) : null}
      {apiError?.requestId ? (
        <p className="mt-2 break-all font-mono text-[11px] select-all">Request ID: {apiError.requestId}</p>
      ) : null}
    </InlineNotice>
  )
}
