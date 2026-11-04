// Local owner client. Request files keep text and approvals out of shell history.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clientConfig } from './client-config.mjs';
import { readPrivate, privateDirectory, writePrivate } from '../dist/private-files.js';
import { strictJson } from '../dist/json.js';
import { actionBinding, isInputOperation } from '../dist/operation.js';
const config = clientConfig();
const recovering = process.argv[2] === '--recover';
const request = process.argv[2] && process.argv[2] !== 'list'
  ? strictJson(readPrivate(process.argv[recovering ? 3 : 2], 65536)) : null;
const client = new Client({name:'phone-owner-client',version:'1'});
try {
  await client.connect(new StreamableHTTPClientTransport(config.url, {requestInit:{headers:config.headers}}));
  if (process.argv[2] === 'list') console.log(JSON.stringify(await client.listTools()));
  else {
    if (!process.argv[2]) throw new Error('Usage: node scripts/call.mjs list|PRIVATE_REQUEST_FILE|--recover ORIGINAL_REQUEST_FILE');
    const binding = isInputOperation(request.name, request.arguments) ? actionBinding(request.name, request.arguments) : null;
    if (recovering && !binding) throw new Error('Recovery requires the original input request');
    const result = await client.callTool(recovering ? { name: 'android_activity_open', arguments: {
      requestId: request.arguments.requestId, receiptOnly: true, expectedTool: binding.tool, expectedArgsDigest: binding.argsDigest,
    } } : request);
    if (binding) {
      const receipt = result.content?.filter(i => i.type === 'text').flatMap(i => { try { return [JSON.parse(i.text).phoneReceipt].filter(Boolean); } catch { return []; } }).at(-1);
      if (!receipt || receipt.requestBinding?.tool !== binding.tool || receipt.requestBinding?.argsDigest !== binding.argsDigest)
        throw new Error('Receipt missing or request binding mismatch; execution unknown, do not replay');
    }
    for (const item of result.content || []) {
      if (item.type === 'image') {
        const directory = privateDirectory(path.resolve('.runtime/client-output'));
        const file = path.join(directory, randomUUID() + '.png');
        writePrivate(file, Buffer.from(item.data, 'base64'));
        console.log(JSON.stringify({imagePath:file,retention:'Owner-managed local export; delete when no longer needed'}));
      } else if (item.type === 'text') console.log(item.text);
    }
    if (result.isError) process.exitCode=1;
  }
} finally { await client.close(); }
