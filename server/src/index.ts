import './env.js';
import { createApp, createPublicApiApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function parsePort(label: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535; received ${value}`);
  }
  return port;
}

function displayHost(host: string): string {
  if (host === '::') return '[::]';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function publicUrlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '<public-ip>';
  return displayHost(host);
}

function listen(app: ReturnType<typeof createApp>, port: number, host: string, label: string, ready: () => void) {
  const server = app.listen(port, host, () => {
    console.log(`${label}: http://${displayHost(host)}:${port}`);
    ready();
  });
  server.on('error', (err) => {
    console.error(`${label} failed to listen on ${host}:${port}`);
    throw err;
  });
  return server;
}

async function main() {
  initDb();

  const dashboardHost = firstEnv('LLMHARBOR_DASHBOARD_HOST', 'DASHBOARD_HOST', 'HOST') ?? '127.0.0.1';
  const dashboardPort = parsePort(
    'LLMHARBOR_DASHBOARD_PORT',
    firstEnv('LLMHARBOR_DASHBOARD_PORT', 'DASHBOARD_PORT', 'PORT') ?? '3001',
  );

  const publicApiPortValue = firstEnv('LLMHARBOR_PUBLIC_API_PORT', 'PUBLIC_API_PORT', 'API_PORT');
  const publicApiHost = firstEnv('LLMHARBOR_PUBLIC_API_HOST', 'PUBLIC_API_HOST', 'API_HOST') ?? '0.0.0.0';
  const splitPublicApi = Boolean(publicApiPortValue);

  let healthStarted = false;
  const startHealthOnce = () => {
    if (!healthStarted) {
      healthStarted = true;
      startHealthChecker();
    }
  };

  if (!splitPublicApi) {
    const app = createApp();
    listen(app, dashboardPort, dashboardHost, 'LLMHarbor dashboard/API', startHealthOnce);
    console.log(`Proxy endpoint: http://${displayHost(dashboardHost)}:${dashboardPort}/v1/chat/completions`);
    if (dashboardHost === '0.0.0.0' || dashboardHost === '::') {
      console.warn('Warning: LLMHarbor is listening on all interfaces. Prefer split mode so only /v1 is public and the dashboard binds to Tailscale/VPN.');
    }
    return;
  }

  const publicApiPort = parsePort('LLMHARBOR_PUBLIC_API_PORT', publicApiPortValue!);
  const dashboardApp = createApp();
  const publicApiApp = createPublicApiApp();

  listen(dashboardApp, dashboardPort, dashboardHost, 'LLMHarbor dashboard', startHealthOnce);
  listen(publicApiApp, publicApiPort, publicApiHost, 'LLMHarbor public API', startHealthOnce);
  console.log(`Public API base: http://${publicUrlHost(publicApiHost)}:${publicApiPort}/v1`);

  if (publicApiHost === '0.0.0.0' || publicApiHost === '::') {
    console.warn('Public API is listening on all interfaces. Keep a firewall in front of it and use strong llmharbor-* client API keys.');
  }
}

main().catch(console.error);
