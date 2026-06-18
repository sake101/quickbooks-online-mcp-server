#!/usr/bin/env node
// Wrapper that syncs QBO tokens between Supabase and the MCP server's .env file.
// Supabase is the source of truth; the MCP server writes rotated tokens to .env;
// this wrapper syncs changes back to Supabase so the daily agent stays in sync.

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync } from 'fs';
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

async function supabaseUpsert(refreshToken, realmId) {
  // Read current row ID for targeted update (avoids PostgREST limit+PATCH ambiguity)
  const row = await supabaseGet();
  if (!row) {
    process.stderr.write('[qb-mcp-wrapper] No token row to update\n');
    return;
  }
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/qb_tokens?id=eq.${row.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
        realm_id: realmId,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!res.ok) {
    process.stderr.write(`[qb-mcp-wrapper] Supabase upsert failed: ${res.status}\n`);
  }
}

function writeEnvFile(tokens) {
  const lines = [
    `QUICKBOOKS_CLIENT_ID=${QB_CLIENT_ID}`,
    `QUICKBOOKS_CLIENT_SECRET=${QB_CLIENT_SECRET}`,
    `QUICKBOOKS_REFRESH_TOKEN=${tokens.refresh_token}`,
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

  let lastRefreshToken = tokens.refresh_token;

  // Watch .env for token rotation by the MCP server
  watchFile(ENV_PATH, { interval: 2000 }, async () => {
    try {
      const current = readEnvFile();
      if (current?.QUICKBOOKS_REFRESH_TOKEN && current.QUICKBOOKS_REFRESH_TOKEN !== lastRefreshToken) {
        lastRefreshToken = current.QUICKBOOKS_REFRESH_TOKEN;
        await supabaseUpsert(current.QUICKBOOKS_REFRESH_TOKEN, current.QUICKBOOKS_REALM_ID);
        process.stderr.write('[qb-mcp-wrapper] Rotated token synced back to Supabase\n');
      }
    } catch (e) {
      process.stderr.write(`[qb-mcp-wrapper] Watch sync error: ${e.message}\n`);
    }
  });

  // Launch the actual MCP server with stdio passthrough
  const child = spawn('node', [join(__dirname, 'dist', 'index.js')], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env },
  });

  // Forward signals
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }

  child.on('exit', async (code) => {
    unwatchFile(ENV_PATH);
    // Final sync
    try {
      const current = readEnvFile();
      if (current?.QUICKBOOKS_REFRESH_TOKEN && current.QUICKBOOKS_REFRESH_TOKEN !== tokens.refresh_token) {
        await supabaseUpsert(current.QUICKBOOKS_REFRESH_TOKEN, current.QUICKBOOKS_REALM_ID);
        process.stderr.write('[qb-mcp-wrapper] Final token sync to Supabase on exit\n');
      }
    } catch (e) {
      process.stderr.write(`[qb-mcp-wrapper] Final sync error: ${e.message}\n`);
    }
    process.exit(code || 0);
  });
}

main().catch(e => {
  process.stderr.write(`[qb-mcp-wrapper] Fatal: ${e.message}\n`);
  process.exit(1);
});
