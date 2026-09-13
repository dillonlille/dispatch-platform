'use strict';
const path=require('node:path');
async function main([command,noun,value,...rest]){
 if(rest.length||!value)throw new Error('plugin_cli_arguments_invalid');
 if(command==='create'&&noun==='plugin')return require('dispatch-sdk/tooling/create-plugin').createPlugin({id:value,directory:path.resolve('plugins',value)});
 if(command!=='plugin')throw new Error('plugin_cli_arguments_invalid');
 const pluginRoot=path.resolve(/^[a-z][a-z0-9-]{0,63}$/.test(value)?path.join('plugins',value):value);
 if(noun==='generate'||noun==='check')return require('dispatch-sdk/tooling/plugin-contracts').generateContracts(pluginRoot,{check:noun==='check'});
 if(noun==='dev')throw new Error('Use the Core development runner with this plugin path; see DEVELOPMENT.md.');
 throw new Error('plugin_cli_arguments_invalid');
}
module.exports={main};
