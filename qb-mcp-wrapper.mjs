#!/usr/bin/env node
// Wrapper that syncs QBO tokens between Supabase and the MCP server's .env file.
// Supabase is the source of truth; the MCP server writes rotated tokens to .env;
// this wrapper syncs changes back to Supabase so the daily agent stays in sync.

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QB_CLIENT_ID = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;

if (!SUPABASE_URL || !SUPABASE_KEY || !QB_CLIENT_ID || !QB_CLIENT_SECRET) {
  process.stderr.write('[qb-mcp-wrapper] Missing required env vars\n');
  process.exit(1);
}

async function supabaseGet() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/qb_tokens?select=id,access_token,refresh_token,realm_id,expires_at&order=updated_at.desc&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0] || null;
}

async function edgeFunctionRefresh() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/qb-token-refresh`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function writeEnvFile(tokens) {
  const lines = [
    `QUICKBOOKS_CLIENT_ID=${QB_CLIENT_ID}`,
    `QUICKBOOKS_CLIENT_SECRET=${QB_CLIENT_SECRET}`,
    // ponytail: no refresh token on disk. With SUPABASE_* set the server refreshes only via the Edge Function.
    `QUICKBOOKS_REALM_ID=${tokens.realm_id}`,
    `QUICKBOOKS_ENVIRONMENT=production`,
  ];
  writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

function readEnvFile() {
  if (!existsSync(ENV_PATH)) return null;
  const content = readFileSync(ENV_PATH, 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(\w+)=(.+)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

async function main() {
  // Pre-flight: use Edge Function to get a fresh access token (serialized
  // across all consumers), then fall back to raw Supabase read.
  let tokens = await edgeFunctionRefresh();
  if (tokens) {
    process.stderr.write(`[qb-mcp-wrapper] Got tokens via Edge Function (refreshed=${tokens.refreshed})\n`);
    // Edge Function returns access_token + realm_id but not refresh_token.
    // Merge with Supabase row to get full set for .env.
    const row = await supabaseGet();
    if (row) tokens = { ...row, access_token: tokens.access_token };
  }
  if (!tokens) {
    tokens = await supabaseGet();
  }
  if (!tokens) {
    process.stderr.write('[qb-mcp-wrapper] No tokens in Supabase. Run OAuth flow first.\n');
    process.exit(1);
  }
  writeEnvFile(tokens);
  process.stderr.write('[qb-mcp-wrapper] Synced tokens → .env\n');

  // ponytail: no .env -> Supabase write-back. The MCP server refreshes only via the
  // Edge Function now; blind PATCHes here orphaned the live token on 2026-11-17.

  // Launch the actual MCP server with stdio passthrough
  const child = spawn('node', [join(__dirname, 'dist', 'index.js')], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  // Forward signals
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

main().catch(e => {
  process.stderr.write(`[qb-mcp-wrapper] Fatal: ${e.message}\n`);
  process.exit(1);
});
