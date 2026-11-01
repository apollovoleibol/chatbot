const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const minor={id:'t',name:'Base',category:'Escolinha',age_min:12};const adult={id:'a',name:'Adulto',category:'Adulto',age_min:17};
function scope(){const writes=[];const c=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})},Logger:{log(){}},UrlFetchApp:{fetch:(u,o)=>{writes.push(JSON.parse(o.payload));return {getResponseCode:()=>201,getContentText:()=> '[]'};}}});vm.runInContext(fs.readFileSync('apps-script/BookingConsent.gs','utf8')+'\n'+fs.readFileSync('apps-script/Code.gs','utf8'),c);c.CHAT_METRICS_CONTEXT=null;c.buscarEquipeAgendamento_=()=>minor;return {c,writes};}
const CHAT='41911112222';

test('adult team: only the athlete, confirmed, no guardian',()=>{const {c}=scope();const b=c.bookingForTeam_(adult,'Atleta Adulto',{nome_menor:'Ignore isso',nome_responsavel:'Ignore isso'},CHAT);
  assert.equal(b.name,'Atleta Adulto');assert.equal(b.minor_name,null);assert.equal(b.status,'CONFIRMED');assert.equal(b.booking_consent.state,'NOT_REQUIRED');
  assert.throws(()=>c.bookingForTeam_(adult,'Atleta',{},CHAT));assert.throws(()=>c.bookingTeamIsMinor_({category:'',age_min:null}));});

test('guardian chatting: chat number becomes the guardian WhatsApp and booking is confirmed',()=>{const {c}=scope();
  const b=c.bookingForTeam_(minor,'Mae do Atleta',{quem_agenda:'RESPONSAVEL',nome_menor:'Atleta Menor',relacao:'PAI_MAE'},CHAT);
  assert.equal(b.name,'Mae do Atleta');assert.equal(b.minor_name,'Atleta Menor');assert.equal(b.status,'CONFIRMED');
  assert.equal(b.booking_consent.guardianPhone,CHAT);assert.equal(b.booking_consent.guardianRelationship,'PARENT');assert.equal(b.booking_consent.declaredBy,'GUARDIAN');});

test('minor chatting: guardian name and a different WhatsApp are mandatory',()=>{const {c}=scope();
  const base={quem_agenda:'ATLETA',nome_menor:'Atleta Menor',relacao:'RESPONSAVEL_LEGAL'};
  assert.throws(()=>c.bookingForTeam_(minor,'Atleta Menor',base,CHAT),/nome completo do pai/);
  assert.throws(()=>c.bookingForTeam_(minor,'Atleta Menor',{...base,nome_responsavel:'Responsavel Adulto'},CHAT),/WhatsApp/);
  assert.throws(()=>c.bookingForTeam_(minor,'Atleta Menor',{...base,nome_responsavel:'Responsavel Adulto',whatsapp_responsavel:'55 '+CHAT},CHAT),/diferente/);
  assert.throws(()=>c.bookingForTeam_(minor,'Atleta Menor',{...base,nome_responsavel:'Atleta Menor',whatsapp_responsavel:'41933334444'},CHAT),/diferente do nome/);
  const b=c.bookingForTeam_(minor,'Atleta Menor',{...base,nome_responsavel:'Responsavel Adulto',whatsapp_responsavel:'(41) 93333-4444'},CHAT);
  assert.equal(b.name,'Responsavel Adulto');assert.equal(b.status,'CONFIRMED');assert.equal(b.booking_consent.guardianPhone,'41933334444');
  assert.equal(b.booking_consent.guardianRelationship,'LEGAL_GUARDIAN');assert.equal(b.booking_consent.declaredBy,'MINOR');});

test('nothing is stored for a minor without guardian data; stored booking carries the guardian',()=>{const {c,writes}=scope();
  for(const data of [{nome_menor:'Atleta Menor'},{quem_agenda:'ATLETA',nome_menor:'Atleta Menor',nome_responsavel:'Responsavel Adulto',relacao:'PAI_MAE'},{quem_agenda:'RESPONSAVEL',nome_menor:'Atleta Menor'}])
    assert.throws(()=>c.registrarAgendamento(CHAT,'Atleta Menor',data));
  assert.equal(writes.length,0);
  c.registrarAgendamento(CHAT,'Atleta Menor',{quem_agenda:'ATLETA',nome_menor:'Atleta Menor',nome_responsavel:'Responsavel Adulto',whatsapp_responsavel:'41933334444',relacao:'PAI_MAE'});
  assert.equal(writes[0].name,'Responsavel Adulto');assert.equal(writes[0].status,'CONFIRMED');assert.equal(writes[0].whatsapp_phone,CHAT);assert.equal(writes[0].booking_consent.guardianPhone,'41933334444');});

test('history recovery applies the same rule',()=>{const {c,writes}=scope();let extracted={equipe:'Base',data:'2026-11-01T12:00',nome_menor:'Atleta Menor',quem_agenda:'ATLETA'};
  c.obterAgendamentoAtivo=()=>null;c.normalizarDadosAgendamento=()=>null;c.chamarGemini=()=>({candidates:[{content:{parts:[{text:JSON.stringify(extracted)}]}}]});c.enviarEmailAgendamento=()=>{};c.atualizarFaseSupabase=()=>{};
  assert.equal(c.recuperarAgendamentoDoHistorico(CHAT,'Atleta Menor',[]).status,'erro');assert.equal(writes.length,0);
  Object.assign(extracted,{nome_responsavel:'Responsavel Adulto',whatsapp_responsavel:'41933334444',relacao:'PAI_MAE'});
  assert.equal(c.recuperarAgendamentoDoHistorico(CHAT,'Atleta Menor',[]).status,'recuperado');assert.equal(writes[0].status,'CONFIRMED');});
