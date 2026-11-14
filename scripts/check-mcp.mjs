import { clientConfig } from './client-config.mjs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const config=clientConfig();
const endpoint=config.url;
if (process.argv.includes('--wait')) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const response = await fetch(new URL('/healthz', endpoint), { signal: AbortSignal.timeout(1000), headers:config.headers });
      const health = await response.json();
      assert(response.ok && health.service === 'phone-use' && health.tools === 36);
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('Phone MCP did not become ready within 20 seconds');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
const client = new Client({ name: 'phone-readiness-check', version: '0.2.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:config.headers}}));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 36);
  assert.equal(tools.find(t => t.name === 'android_screenshot_keep').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'android_screenshot_keepsakes').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'android_clip_open').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'android_clip_keep').annotations.readOnlyHint, false);
  assert(tools.find(t => t.name === 'android_capture_clip').inputSchema.required.includes('requestId'));
  assert.equal(tools.find(t => t.name === 'android_tap').inputSchema.properties.imageMode.default, 'inline');
  assert(tools.find(t => t.name === 'android_tap').inputSchema.properties.requestId);
  assert(tools.find(t => t.name === 'android_activity_open').inputSchema.properties.receiptOnly);
  for (const name of ['android_tap', 'android_tap_element', 'android_double_tap', 'android_long_press', 'android_swipe', 'android_drag', 'android_gesture'])
    assert.equal(tools.find(t => t.name === name)?.inputSchema.properties.observeAfterMs?.maximum, 5000);
  for (const name of ['android_activity_reading', 'android_chrome_read', 'android_gesture', 'android_power_status', 'android_set_text', 'android_activity_context', 'android_activity_history', 'android_activity_open']) assert(tools.some(t => t.name === name));
  console.log(JSON.stringify({ server: client.getServerVersion(), toolCount: tools.length, phoneActionAttempted: false }));
} finally { await client.close(); }
