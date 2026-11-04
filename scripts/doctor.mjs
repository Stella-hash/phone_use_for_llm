// Offline by default. --device explicitly contacts only the configured USB phone.
import { OwnerSecurity } from '../dist/security.js';
import { AdbClient } from '../dist/adb.js';
import { withDeadline } from '../dist/deadline.js';
import { localDeviceSerial } from '../dist/device.js';
const report={node:process.versions.node,securityConfigured:false,deviceContacted:false,deviceReady:null,modelKeyRequired:false};
try{
  new OwnerSecurity(process.env.PHONE_SECURITY_FILE);report.securityConfigured=true;
  if(process.argv.includes('--device')){
    const device=localDeviceSerial(process.env.PHONE_DEVICE);
    report.deviceContacted=true;
    report.deviceReady=withDeadline(5000,()=>new AdbClient().adb(device,'get-state').toString().trim()==='device');
    if(!report.deviceReady)process.exitCode=1;
  }
}catch{report.error='Configuration or device check failed';process.exitCode=1;}
console.log(JSON.stringify(report,null,2));
