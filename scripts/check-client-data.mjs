// Source repos hold reusable code, never client inboxes, exports or credentials.
// Intentionally bounded: this detects known leakage shapes, not arbitrary personal information.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=execFileSync('git',['ls-files','-z'],{maxBuffer:32*1024*1024}).toString().split('\0').filter(Boolean);
const rules=[['client mailbox',new RegExp('(?:^|[^A-Z0-9._%+-])(?!(?:info|hello|support|sales|contact)@)[A-Z0-9._%+-]+@(?:vistar\\.me|essentialbrands\\.ae)','i')],['UAE bank account',/\bAE\d{21}\b/]];
const bad=[];
for(const file of files){
 if(/(^|\/)(raw|client-exports|mailbox-exports)\//i.test(file))bad.push({file,rule:'client export directory'});
 if(/(^|\/)\.env(?:\.|$)/.test(file)&&!/(example|sample|template)$/.test(file))bad.push({file,rule:'environment file'});
 const stat=fs.lstatSync(file);if(stat.isSymbolicLink())continue;
 if(stat.size>4*1024*1024){if(/\.(csv|tsv|json|jsonl|sql|log|md|txt)$/i.test(file))bad.push({file,rule:'oversize data requires review'});continue;}
 const data=fs.readFileSync(file);if(data.includes(0))continue;
 const text=data.toString('utf8');for(const [rule,re] of rules)if(re.test(text))bad.push({file,rule});
}
// Values and matching lines never enter CI output.
for(const {file,rule} of bad)console.error(JSON.stringify({file,rule}));
console.log('client-data check: '+files.length+' tracked files, '+bad.length+' findings');
process.exitCode=bad.length?1:0;
