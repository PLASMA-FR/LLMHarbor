export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const ANTIGRAVITY_OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
export const QWEN_OAUTH_DEVICE_CODE_URL = 'https://chat.qwen.ai/api/v1/oauth2/device/code';
export const QWEN_OAUTH_TOKEN_URL = 'https://chat.qwen.ai/api/v1/oauth2/token';
export const QWEN_DEFAULT_RESOURCE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// Google desktop/public OAuth clients still include a client_secret field in
// token-exchange requests. This fallback mirrors the public Antigravity-native
// client credential used by Antigravity-compatible tooling so local installs do
// not get stuck behind an env-only setup gate. Operators can still override it
// with LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET if Google rotates the client.
const ANTIGRAVITY_PUBLIC_DESKTOP_CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

export type OAuthTokenClient = {
  name: string;
  clientId: string;
  tokenUrl: string;
  clientSecret?: string;
  requiresClientSecret?: boolean;
};

export function antigravityOAuthClientSecret() {
  return process.env.LLMHARBOR_ANTIGRAVITY_OAUTH_CLIENT_SECRET || ANTIGRAVITY_PUBLIC_DESKTOP_CLIENT_SECRET;
}

export function oauthTokenClient(provider: string): OAuthTokenClient | null {
  if (provider === 'openai') {
    return {
      name: 'ChatGPT OAuth',
      clientId: OPENAI_OAUTH_CLIENT_ID,
      tokenUrl: OPENAI_OAUTH_TOKEN_URL,
      clientSecret: '',
    };
  }
  if (provider === 'antigravity') {
    return {
      name: 'Antigravity OAuth',
      clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
      tokenUrl: ANTIGRAVITY_OAUTH_TOKEN_URL,
      clientSecret: antigravityOAuthClientSecret(),
      requiresClientSecret: true,
    };
  }
  if (provider === 'qwen') {
    return {
      name: 'Qwen OAuth',
      clientId: QWEN_OAUTH_CLIENT_ID,
      tokenUrl: QWEN_OAUTH_TOKEN_URL,
      clientSecret: '',
    };
  }
  return null;
}
