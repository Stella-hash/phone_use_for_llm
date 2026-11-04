// Offline by default. --device explicitly contacts only the configured USB phone.
import { OwnerSecurity } from '../dist/security.js';
import { AdbClient } from '../dist/adb.js';
import { withDeadline } from '../dist/deadline.js';
const report={node:process.versions.node,securityConfigured:false,deviceContacted:false,deviceReady:null,modelKeyRequired:false};
try{
  new OwnerSecurity(process.env.PHONE_SECURITY_FILE);report.securityConfigured=true;
  if(process.argv.includes('--device')){
    if(!/^[A-Za-z0-9_.-]{1,128}$/.test(process.env.PHONE_DEVICE||''))throw new Error('Set a dedicated USB serial');
    report.deviceContacted=true;
    report.deviceReady=withDeadline(5000,()=>new AdbClient().adb(process.env.PHONE_DEVICE,'get-state').toString().trim()==='device');
    if(!report.deviceReady)process.exitCode=1;
  }
}catch{report.error='Configuration or device check failed';process.exitCode=1;}
console.log(JSON.stringify(report,null,2));
