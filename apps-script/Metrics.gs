// Huddle telemetry v1. All timestamps come from PostgreSQL, never browser clocks.
var CHAT_METRICS_CONTEXT = null;
// As funções de coleta só aceitam service_role. Se SUPABASE_KEY for a chave pública (anon), cadastre a
// chave de servidor na propriedade SUPABASE_SERVICE_KEY (Configurações do projeto → Propriedades do script).
function metricsKey_() {
  return PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY') || SUPABASE_KEY;
}
function metricsRpc_(name, payload) {
  var key = metricsKey_();
  var response = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'post', contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) throw new Error('Telemetry HTTP ' + response.getResponseCode());
  return JSON.parse(response.getContentText() || 'null');
}
function metricsBegin_(phone, name, test) {
  return metricsRpc_('v2_chat_begin', { p_phone: phone, p_name: name || 'Contato Apollo', p_test: test === true });
}
function metricsEvent_(context, kind, extra) {
  if (!context || !context.id || !context.token) throw new Error('Telemetry session missing');
  return metricsRpc_('v2_chat_event', {
    p_session: context.id, p_token: context.token, p_kind: kind,
    p_request: context.requestId || null, p_tryout: extra && extra.tryout || null,
    p_score: extra && extra.score != null ? extra.score : null,
    p_phone: context.phone || null
  });
}
function metricsSafeEvent_(context, kind, extra) {
  try { metricsEvent_(context, kind, extra); return true; }
  catch (e) { Logger.log('[METRICS_ERROR] ' + kind + ': ' + e.message); return false; }
}
function processChatWithMetrics(history, userData, metrics, requestId) {
  var context = metrics && metrics.id && metrics.token ? {
    id: metrics.id, token: metrics.token, requestId: requestId, phone: userData.whatsapp
  } : null;
  var started = false;
  // Clients without a valid session keep their chat, but never fabricate measurements.
  if (context && /^[0-9a-f-]{36}$/i.test(requestId || '')) started = metricsSafeEvent_(context, 'message');
  CHAT_METRICS_CONTEXT = started ? context : null;
  try {
    var result = processChatMessage(history, userData);
    var recorded = started && metricsSafeEvent_(context, result.telemetryFailure ? 'failure' : 'response');
    result.metricsRecorded = !!recorded;
    return result;
  } finally { CHAT_METRICS_CONTEXT = null; }
}
function startChatWithMetrics(phone, name) {
  var result = carregarDadosIniciais(phone);
  try { result.metrics = metricsBegin_(phone, name, false); }
  catch (e) { Logger.log('[METRICS_ERROR] begin: ' + e.message); result.metrics = null; }
  return result;
}
function registerChatClientEvent(payload) {
  if (!payload || ['handoff','score'].indexOf(payload.kind) < 0) throw new Error('Invalid telemetry event');
  return metricsEvent_(payload.metrics, payload.kind, { score: payload.score });
}
// Safe deployment diagnostic: no Gemini request, booking, email or WhatsApp message.
// Test rows are explicitly excluded from dashboards and contact queues.
function diagnosticarMetricasAtendimento() {
  var context = metricsBegin_('00000000000', 'Diagnóstico técnico Huddle', true);
  context.phone = '00000000000';
  context.requestId = Utilities.getUuid();
  metricsEvent_(context,'message');
  metricsEvent_(context,'response');
  metricsEvent_(context,'handoff');
  metricsEvent_(context,'score',{score:5});
  Logger.log('HUDDLE_METRICS_OK: sessão, mensagem, resposta, encaminhamento e avaliação registrados em modo de teste.');
}
