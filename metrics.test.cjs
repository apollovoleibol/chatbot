const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function scope() {
  const events=[];
  const c=vm.createContext({Logger:{log(){}},Utilities:{getUuid:()=> '22222222-2222-4222-8222-222222222222'},
    processChatMessage:()=>({text:'Olá',confetti:false}),carregarDadosIniciais:()=>({history:[]})});
  vm.runInContext(fs.readFileSync('apps-script/Metrics.gs','utf8'),c);
  c.metricsRpc_=(name,payload)=>{events.push({name,...payload});return {id:'session',token:'capability',recorded:true};};
  return {c,events};
}
test('timestamps are not supplied by client and responses follow received messages',()=>{
  const {c,events}=scope();
  const result=c.processChatWithMetrics([],{whatsapp:'41999999999'},{id:'session',token:'capability'},'11111111-1111-4111-8111-111111111111');
  assert.equal(result.metricsRecorded,true);
  assert.deepEqual(events.map(e=>e.p_kind),['message','response']);
  assert.equal(events[0].p_phone,'41999999999');
  assert.equal(events[0].timestamp,undefined);
  assert.equal(c.CHAT_METRICS_CONTEXT,null);
});
test('failed assistant responses do not count as useful first replies',()=>{
  const {c,events}=scope();c.processChatMessage=()=>({text:'Tente novamente',telemetryFailure:true});
  c.processChatWithMetrics([],{whatsapp:'41999999999'},{id:'session',token:'capability'},'11111111-1111-4111-8111-111111111111');
  assert.deepEqual(events.map(e=>e.p_kind),['message','failure']);
});
test('telemetry outage cannot stop a chat response',()=>{
  const {c}=scope();c.metricsRpc_=()=>{throw Error('offline');};
  const result=c.processChatWithMetrics([],{whatsapp:'41999999999'},{id:'session',token:'capability'},'11111111-1111-4111-8111-111111111111');
  assert.equal(result.text,'Olá');assert.equal(result.metricsRecorded,false);
});
test('public action cannot forge bookings, timestamps or human responses',()=>{
  const {c}=scope();
  for(const kind of ['booking','message','response','human_reply']) assert.throws(()=>c.registerChatClientEvent({kind}),/Invalid telemetry/);
});
test('missing sessions never fabricate first-response measurements',()=>{
  const {c,events}=scope();c.processChatWithMetrics([],{whatsapp:'41999999999'},null,null);
  assert.equal(events.length,0);
});
test('booking is recorded only after successful persisted insert, including exact created id',()=>{
  const metrics=[];let code=201;
  const c=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})},
    Logger:{log(){}},UrlFetchApp:{fetch:()=>({getResponseCode:()=>code,getContentText:()=>JSON.stringify([{id:'tryout-1'}])})}});
  vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),c);
  c.buscarTeamId=()=> 'team-1';c.CHAT_METRICS_CONTEXT={id:'session'};c.metricsSafeEvent_=(ctx,kind,data)=>metrics.push({kind,data});
  assert.equal(c.registrarAgendamento('41999999999','Contato',{equipe:'Time',data:'2026-10-10T12:00:00-03:00'}),true);
  assert.equal(metrics[0].data.tryout,'tryout-1');
  code=500;assert.equal(c.registrarAgendamento('41999999999','Contato',{equipe:'Time'}),false);
  assert.equal(metrics.length,1);
});
test('booking never depends on metrics: no session uses return=minimal; unreadable representation retries',()=>{
  const prefs=[];let codes=[];
  const c=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})},
    Logger:{log(){}},UrlFetchApp:{fetch:(u,o)=>{prefs.push(o.headers.Prefer);const code=codes.shift();return {getResponseCode:()=>code,getContentText:()=>''};}}});
  vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),c);
  c.buscarTeamId=()=> 'team-1';c.metricsSafeEvent_=()=>true;
  codes=[201];c.CHAT_METRICS_CONTEXT=null;
  assert.equal(c.registrarAgendamento('41999999999','Contato',{equipe:'Time'}),true);
  assert.deepEqual(prefs,['return=minimal']);
  prefs.length=0;codes=[403,201];c.CHAT_METRICS_CONTEXT={id:'session'};
  assert.equal(c.registrarAgendamento('41999999999','Contato',{equipe:'Time'}),true);
  assert.deepEqual(prefs,['return=representation','return=minimal']);
});
