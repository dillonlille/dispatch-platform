'use strict';
const implementation=require('../sdk/tooling/verify-boundaries');
const verify=(root=require('node:path').resolve(__dirname,'..'))=>implementation.verify(root);
if(require.main===module){try{console.log(JSON.stringify(verify()));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={...implementation,verify};
