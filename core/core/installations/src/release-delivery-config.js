'use strict';
const path=require('node:path');
const { exact, fail }=require('./release-delivery-contract');
const CONFIG='/etc/dispatch/release-delivery.json';
const TOKEN='/etc/dispatch/release-delivery-token';
const STATE='/var/lib/dispatch-release-delivery';
function configuration(value) {
  exact(value,['uid','gid','localRoot','unitRoot','publicOrigin','port']);
  if(!Number.isSafeInteger(value.uid)||value.uid<100||!Number.isSafeInteger(value.gid)||value.gid<100
    ||!Number.isInteger(value.port)||value.port<1024||value.port>65535||value.publicOrigin!=='https://dispatch.example.test')fail('release_config_invalid');
  for(const key of ['localRoot','unitRoot'])if(typeof value[key]!=='string'||!/^\/[A-Za-z0-9_./-]+$/.test(value[key])
    ||path.resolve(value[key])!==value[key]||value[key]==='/')fail('release_config_invalid');
  return value;
}
module.exports={configuration,CONFIG,TOKEN,STATE};
