const assert = require('node:assert/strict');
const A = require('./analytics.js');

const rows = [
  {date:'2026-08-25',device:'mac',deviceName:'Mac',client:'codex',model:'gpt-5.6-sol',upstreamVendor:'openai',routeProvider:'openai',routeType:'official',provider:'openai',tier:'fast',input:10,cacheRead:90,cacheWrite:0,output:5,reasoning:1,messages:2,costUsd:1.5,costLowerBound:true},
  {date:'2026-08-26',device:'win',deviceName:'Windows',client:'codex',model:'gpt-5.6-sol',upstreamVendor:'openai',routeProvider:'newapi',routeType:'relay',provider:'my-newapi',tier:'standard',input:20,cacheRead:80,cacheWrite:0,output:4,reasoning:0,messages:3,costUsd:2.5,costLowerBound:false},
  {date:'2026-08-26',device:'linux',deviceName:'Linux',client:'claude',model:'claude-sonnet-4',upstreamVendor:'anthropic',routeProvider:'aws-bedrock',routeType:'cloud',provider:'bedrock',tier:null,input:30,cacheRead:0,cacheWrite:4,output:8,reasoning:0,messages:1,costUsd:3.5,costLowerBound:false}
];

assert.equal(A.totalTokens(rows[0]), 106);
assert.equal(A.sumRows(rows).costUsd, 7.5);
assert.equal(A.sumRows(rows).costLowerBound, true);
assert.equal(A.filterRows(rows,{routeType:'relay'}).length,1);
assert.equal(A.filterRows(rows,{start:'2026-08-26',end:'2026-08-26'}).length,2);
assert.deepEqual(A.groupRows(rows,'device','totalTokens').map(x=>x.key).sort(),['Linux','Mac','Windows']);
assert.equal(A.groupRows(rows,'upstreamVendor','costUsd').find(x=>x.key==='openai').value,4);
const matrix=A.groupMatrix(rows,'date','routeProvider','costUsd');
assert.equal(matrix.value('2026-08-26','newapi'),2.5);
assert.ok(A.squarify([{key:'a',value:2},{key:'b',value:1}],0,0,300,100).length===2);
const csv=A.toCsv(rows);
assert.match(csv,/routeProvider/);
assert.match(csv,/costLowerBound/);
assert.match(csv,/newapi/);
assert.doesNotMatch(csv,/sessions|durationMs|prompt/i);
console.log('dashboard analytics tests passed');
