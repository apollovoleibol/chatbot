// A minor may initiate. Only staff may confirm guardian authorization.
var BOOKING_LAST_RESULT = null;
var BOOKING_CONTACT_PHONE = null;
var BOOKING_TEAM_CACHE = {};
function consentName_(value) { return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
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
function bookingForTeam_(team, contactName, data) {
  var minor=bookingTeamIsMinor_(team);
  var athlete=String(data.nome_menor||'').trim(),guardian=String(data.nome_responsavel||'').trim();
  var name=minor?guardian:String(contactName||'').trim();
  if(name.split(/\s+/).length<2) throw new Error(minor?'Informe o nome completo do responsável.':'Informe o nome completo do atleta.');
  if(minor && (athlete.split(/\s+/).length<2 || consentName_(guardian)===consentName_(athlete))) throw new Error('Informe nomes completos e diferentes para o responsável e o atleta menor.');
  return {name:name,minor_name:minor?athlete:null,status:minor?'PENDING':'CONFIRMED',
    booking_consent:{version:'2026-10-29',subjectType:minor?'MINOR':'SELF',state:minor?'PENDING_GUARDIAN':'NOT_REQUIRED',guardianConsent:false,adultConfirmed:false,source:'chatbot'}};
}
