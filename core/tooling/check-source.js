'use strict';
const {check}=require('../sdk/tooling/check-source');
if(require.main===module){try{console.log(JSON.stringify(check(require('node:path').resolve(__dirname,'..'))));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={check};
