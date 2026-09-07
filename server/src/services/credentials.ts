import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { ProviderError, type CompletionOptions } from '../providers/base.js';
import { ensureFreshOAuthAccount } from './oauth-refresh.js';

export interface ProviderCredential {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  source: string;
  oauth_account_id: number | null;
  oauth_provider: string | null;
  oauth_account_hint: string | null;
  oauth_metadata_json: string | null;
}

// Only static SQL expressions are accepted. Keep routing, catalog visibility,
// and model probes on the same credential/account eligibility rules.
export function routeableCredentialSql(model: '?' | 'm.model_id' = '?'): string {
  return `ak.enabled = 1
    AND (ak.status IN ('healthy', 'unknown') OR (ak.source = 'oauth' AND ak.status NOT IN ('invalid', 'error')))
    AND (ak.source != 'oauth' OR (
      oa.enabled = 1
      AND CASE WHEN json_valid(oa.metadata_json) THEN COALESCE(json_extract(oa.metadata_json, '$.oauthNeedsReconnect'), 0) ELSE 1 END != 1
      AND (
        NOT EXISTS (SELECT 1 FROM oauth_account_models known WHERE known.oauth_account_id = ak.oauth_account_id)
        OR EXISTS (SELECT 1 FROM oauth_account_models eligible
          WHERE eligible.oauth_account_id = ak.oauth_account_id
            AND eligible.platform = ak.platform AND eligible.model_id = ${model} AND eligible.supported = 1)
      )
    ))`;
}

const credentialColumns = `ak.*, oa.provider AS oauth_provider,
  oa.account_hint AS oauth_account_hint, oa.metadata_json AS oauth_metadata_json`;

export function getRouteCredentials(platform: string, modelId: string): ProviderCredential[] {
  return getDb().prepare(`SELECT ${credentialColumns} FROM api_keys ak
    LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
    WHERE ak.platform = ? AND ${routeableCredentialSql()}
    ORDER BY CASE ak.status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, ak.id ASC
  `).all(platform, modelId) as ProviderCredential[];
}

export function oauthOptionsForCredential(key: ProviderCredential): CompletionOptions['oauth'] {
  if (!key.oauth_account_id || !key.oauth_provider) return undefined;
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(key.oauth_metadata_json ?? '{}'); } catch { /* eligibility rejects invalid metadata */ }
  return {
    accountId: key.oauth_account_id,
    provider: key.oauth_provider,
    accountHint: key.oauth_account_hint,
    metadata,
  };
}

/** Refresh OAuth tokens and carry account metadata to the provider adapter. */
export async function prepareProviderCredential(keyId: number, signal?: AbortSignal): Promise<{ apiKey: string; oauth?: CompletionOptions['oauth'] }> {
  signal?.throwIfAborted();
  const db = getDb();
  const key = db.prepare(`SELECT ${credentialColumns} FROM api_keys ak
    LEFT JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id WHERE ak.id = ? AND ak.enabled = 1
  `).get(keyId) as ProviderCredential | undefined;
  if (!key) throw new ProviderError('Provider credential is unavailable.', { retryable: true });
  if (!key.oauth_account_id) return { apiKey: decrypt(key.encrypted_key, key.iv, key.auth_tag) };

  const account = await ensureFreshOAuthAccount(db, key.oauth_account_id, signal);
  signal?.throwIfAborted();
  if (!account || !db.prepare(`SELECT 1 FROM api_keys ak JOIN oauth_accounts oa ON oa.id = ak.oauth_account_id
    WHERE ak.id = ? AND ak.enabled = 1 AND oa.enabled = 1`).get(keyId)) {
    throw new ProviderError('Provider credential was disabled during preparation.', { retryable: true });
  }
  return {
    apiKey: decrypt(account.encrypted_access_token, account.access_iv, account.access_auth_tag),
    oauth: oauthOptionsForCredential({ ...key, oauth_metadata_json: account.metadata_json }),
  };
}
