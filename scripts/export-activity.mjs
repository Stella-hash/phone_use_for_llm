// Explicit owner-managed export. Exported text/receipts remain private.
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { OwnerSecurity } from '../dist/security.js';
import { privateDirectory, noLinks, writePrivate, assertPrivate } from '../dist/private-files.js';
const security=new OwnerSecurity(process.env.PHONE_SECURITY_FILE);
if(!process.argv[2])throw new Error('Usage: node scripts/export-activity.mjs PRIVATE_OUTPUT_DIRECTORY');
const directory=privateDirectory(path.resolve(process.argv[2]));
const source=path.join(security.directory,'activity.sqlite3');
const target=path.join(directory,'activity.sqlite3');
if(target===source)throw new Error('Export must be outside active data');
noLinks(source);assertPrivate(source);
writePrivate(target,''); // Exclusive reservation in a private directory; never overwrite.
const db=new DatabaseSync(source,{readOnly:true});
try{
  await backup(db,target);
  const snapshot=new DatabaseSync(target,{readOnly:true});
  try{
    if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Export integrity failed');
  }finally{snapshot.close();}
  assertPrivate(target);
  console.log(JSON.stringify({target,integrity:'ok',includes:'journal and replay ledger',imagesIncluded:false,
    retention:'Owner-managed export; not covered by service expiry. Protect and delete separately.'}));
}finally{db.close();}
