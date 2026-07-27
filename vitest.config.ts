import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd via Miniflare, so KV, crypto.subtle and Intl behave
// exactly as they will in production rather than as Node approximations.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Stand-in secrets so the Worker's own handlers can be exercised.
        // All fake; nothing here reaches a real tenant.
        bindings: {
          GRAPH_TENANT_ID: 'test-tenant',
          GRAPH_CLIENT_ID: 'test-client',
          GRAPH_CLIENT_SECRET: 'test-client-secret',
          TARGET_UPN: 'tester@example.com',
          MANUAL_TRIGGER_TOKEN: 'test-manual-trigger-token-0123456789abcdef',
        },
      },
    }),
  ],
});
