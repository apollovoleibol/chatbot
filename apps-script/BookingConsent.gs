// Agendamento de menor só é gravado ligado a um responsável legal maior de idade:
// nome completo do atleta, nome completo do responsável, WhatsApp do responsável e relação.
// Quem conversa pode ser o próprio responsável (o WhatsApp do chat é o dele) ou o atleta
// (o WhatsApp do responsável é obrigatório e diferente do número do chat).
// A mesma regra é garantida no banco (migração 042 do Huddle).
var BOOKING_LAST_RESULT = null;
var BOOKING_CONTACT_PHONE = null;
var BOOKING_TEAM_CACHE = {};
function consentName_(value) { return String(value||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
function consentPhone_(value) { var d=String(value||'').replace(/\D/g,''); if(d.length>11 && d.indexOf('55')===0) d=d.slice(2); return d; }
function bookingTeamIsMinor_(team) {
  var category=String(team.category||'');
  if (/^adulto/i.test(category)) return false;
  if (team.age_min !== null && team.age_min !== undefined && team.age_min !== '' && Number.isFinite(Number(team.age_min))) return Number(team.age_min)<18;
  if (/sub|escolinha|base|infantil|juvenil/i.test(category)) return true;
  throw new Error('A faixa etária desta equipe precisa ser conferida pelo atendimento.');
}
function buscarEquipeAgendamento_(name) {
  var id=buscarTeamId(name); if(!id) throw new Error('Equipe não identificada.');
  if(BOOKING_TEAM_CACHE[id]) return BOOKING_TEAM_CACHE[id];
  var response=UrlFetchApp.fetch(SUPABASE_URL+'/rest/v1/teams?id=eq.'+encodeURIComponent(id)+'&select=id,name,category,age_min,age_max',{
    method:'get',headers:{apikey:SUPABASE_KEY,Authorization:'Bearer '+SUPABASE_KEY},muteHttpExceptions:true,deadline:FETCH_DEADLINE});
  if(response.getResponseCode()>=300) throw new Error('Não foi possível conferir a faixa etária da equipe.');
  var rows=JSON.parse(response.getContentText()||'[]');if(!rows.length) throw new Error('Equipe não identificada.');
  BOOKING_TEAM_CACHE[id]=rows[0];return rows[0];
}
// contactName/contactPhone: quem está conversando. data: campos da tag [BOOKING].
function bookingForTeam_(team, contactName, data, contactPhone) {
  var minor=bookingTeamIsMinor_(team);
  if(!minor) {
    var self=String(contactName||'').trim();
    if(self.split(/\s+/).length<2) throw new Error('Para concluir, preciso do seu nome completo (nome e sobrenome).');
    return {name:self,minor_name:null,status:'CONFIRMED',
      booking_consent:{version:'2026-10-31',subjectType:'SELF',state:'NOT_REQUIRED',source:'chatbot'}};
  }
  var byGuardian=String(data.quem_agenda||'').toUpperCase()!=='ATLETA';
  var athlete=String(data.nome_menor||'').trim();
  var guardian=String(data.nome_responsavel||'').trim() || (byGuardian?String(contactName||'').trim():'');
  var phone=consentPhone_(data.whatsapp_responsavel) || (byGuardian?consentPhone_(contactPhone):'');
  var rel=/legal/i.test(String(data.relacao||''))?'LEGAL_GUARDIAN':(/pai|m[aã]e|parent/i.test(String(data.relacao||''))?'PARENT':'');
  if(athlete.split(/\s+/).length<2) throw new Error('Para turmas de menores, preciso do nome completo (nome e sobrenome) do atleta.');
  if(guardian.split(/\s+/).length<2 || consentName_(guardian)===consentName_(athlete)) throw new Error('Preciso do nome completo do pai, mãe ou responsável legal (maior de idade), diferente do nome do atleta.');
  if(!/^\d{10,11}$/.test(phone)) throw new Error('Preciso do WhatsApp do pai, mãe ou responsável legal, com DDD.');
  if(!byGuardian && phone===consentPhone_(contactPhone)) throw new Error('O WhatsApp do responsável precisa ser diferente deste número. Pode me passar o WhatsApp do seu pai, mãe ou responsável legal?');
  if(!rel) throw new Error('O responsável é pai/mãe ou responsável legal do atleta?');
  return {name:guardian,minor_name:athlete,status:'CONFIRMED',guardian_phone:phone,
    booking_consent:{version:'2026-10-31',subjectType:'MINOR',state:'DECLARED',guardianName:guardian,guardianPhone:phone,
      guardianRelationship:rel,declaredBy:byGuardian?'GUARDIAN':'MINOR',source:'chatbot'}};
}
