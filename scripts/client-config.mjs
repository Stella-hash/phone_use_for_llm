import path from 'node:path';
import { readPrivate } from '../dist/private-files.js';

export function clientConfig() {
  const file = process.env.PHONE_SECURITY_FILE;
  if (!file) throw new Error('PHONE_SECURITY_FILE is required');
  const config = JSON.parse(readPrivate(file, 32768));
  const token = readPrivate(path.resolve(path.dirname(file), config.tokenFile), 256).trim();
  const url = new URL(process.env.PHONE_MCP_URL || `http://127.0.0.1:${process.env.PHONE_PORT || 17761}/mcp`);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password)
    throw new Error('Local owner utilities require the loopback /mcp endpoint');
  return { url, headers: { Authorization: `Bearer ${token}` } };
}
