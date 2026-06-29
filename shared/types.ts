// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Moonshot and MiniMax direct integrations were dropped in migrateModelsV4
// (see server/src/db/index.ts). HuggingFace was dropped in V4 and re-added
// in V13 via the router.huggingface.co Inference Providers meta-router.
export type BuiltInPlatform =
  | 'openai'
  | 'google'
  | 'google-oauth'
  | 'groq'
  | 'cerebras'
  | 'sambanova'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'huggingface'
  | 'freebuff';

// Custom OpenAI-compatible endpoints are stored with platform ids like
// `custom-local-vllm`, so runtime platform values must remain open-ended.
export type Platform = BuiltInPlatform | (string & {});

export interface Model {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  source?: 'manual' | 'oauth';
  oauthAccountId?: number | null;
  createdAt: string;
  lastCheckedAt: string | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages. We accept
// it on the wire and flatten to string for providers that don't support it
// (Cohere, Cloudflare). See server/src/lib/content.ts.
export type ChatContentBlock = { type: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Free Model Updater Types ----
export type FreeModelDetectionMethod =
  | 'pricing_tier'
  | 'keyword'
  | 'hardcoded_list'
  | 'unclassified_provider';

export type FreeModelVerificationStatus =
  | 'pending'
  | 'verified'
  | 'unavailable'
  | 'expired'
  | 'no_key';

export type FreeModelUpdaterRunStatus = 'idle' | 'running' | 'error';

export type FreeModelUpdaterProviderSource = 'built-in' | 'custom';

export type FreeModelUpdaterDetectionPolicy =
  | 'priced_catalog'
  | 'openrouter_free_variant_catalog'
  | 'account_free_tier_catalog'
  | 'provider_declared_free_catalog'
  | 'provider_tier_catalog'
  | 'unclassified_all_catalog'
  | 'hardcoded_then_probe'
  | 'custom_catalog';

export interface FreeModelUpdaterProviderOption {
  platform: Platform;
  name: string;
  source: FreeModelUpdaterProviderSource;
  baseUrl: string | null;
  timeoutMs: number | null;
  enabled: boolean;
  selected: boolean;
  hasEnabledKey: boolean;
  canListAnonymously: boolean;
  detectionPolicy: FreeModelUpdaterDetectionPolicy;
}

export interface FreeModelUpdaterStatus {
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  refreshIntervalHours: number;
  status: FreeModelUpdaterRunStatus;
  detectedCount: number;
  errorMessage: string | null;
  selectedProviders: Platform[];
  selectedProviderCount: number;
}

export interface FreeModelUpdaterSettings extends FreeModelUpdaterStatus {}

export interface DetectedFreeModel {
  platform: Platform;
  modelId: string;
  displayName: string;
  detectionMethod: FreeModelDetectionMethod;
  verificationStatus: FreeModelVerificationStatus;
  contextWindow: number | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
