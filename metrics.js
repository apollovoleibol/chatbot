/* Session capability stays in memory. No message text is sent to telemetry. */
'use strict';
let CHAT_METRICS = null;
let CHAT_RATED = false;
let CHAT_SURVEY_DISMISSED = false; // fechada pelo "x": não reaparece nesta conversa
let CHAT_HAD_REPLY = false;        // a nota só é aceita depois de uma resposta útil registrada
function chatMetricId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  return [...bytes].map((b,i) => ([4,6,8,10].includes(i) ? '-' : '') + b.toString(16).padStart(2,'0')).join('');
}
function chatMetricsStart(data) {
  CHAT_METRICS = data?.metrics || null; CHAT_RATED = false;
  CHAT_SURVEY_DISMISSED = false; CHAT_HAD_REPLY = false;
  const survey = document.getElementById('chatSurvey');
  survey.hidden = true;
  survey.querySelectorAll('button').forEach(b => { b.disabled = false; });
  document.getElementById('chatSurveyStatus').textContent = '';
}
// Mostra a pesquisa apenas em momentos de conclusão: agendamento/reagendamento gravado
// (o backend só devolve confetti quando a gravação foi confirmada) ou pedido de atendimento humano.
function chatSurveyShow() {
  if (CHAT_METRICS && CHAT_HAD_REPLY && !CHAT_RATED && !CHAT_SURVEY_DISMISSED)
    document.getElementById('chatSurvey').hidden = false;
}
function chatSurveyDismiss() {
  CHAT_SURVEY_DISMISSED = true;
  document.getElementById('chatSurvey').hidden = true;
}
function chatMetricsOffer(response) {
  if (response?.metricsRecorded && !response.telemetryFailure) CHAT_HAD_REPLY = true;
  if (response?.confetti) chatSurveyShow();
}
async function chatRate(score) {
  if (!CHAT_METRICS || CHAT_RATED) return;
  const survey = document.getElementById('chatSurvey'), status = document.getElementById('chatSurveyStatus');
  survey.querySelectorAll('button').forEach(b => { b.disabled = true; });
  status.textContent = 'Salvando avaliação…';
  try {
    await callBackend('registrarEventoAtendimento', { metrics: CHAT_METRICS, kind: 'score', score });
    CHAT_RATED = true; status.textContent = 'Obrigado! Sua avaliação foi registrada.';
    setTimeout(() => { survey.hidden = true; }, 2500);
  } catch (e) {
    status.textContent = 'Não foi possível salvar. Toque na nota para tentar novamente.';
    survey.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}
async function chatRecordHandoff() {
  if (!CHAT_METRICS) throw new Error('Sessão de atendimento indisponível');
  return callBackend('registrarEventoAtendimento', { metrics: CHAT_METRICS, kind: 'handoff' });
}
function chatOpenHandoff() {
  window.open(WA_LINK, '_blank', 'noopener,noreferrer');
  document.getElementById('waModal').classList.remove('open');
  // Sem sessão de medição (backend antigo ou coleta indisponível): o atendimento segue normal, sem avisos ao usuário.
  if (!CHAT_METRICS) return;
  chatSurveyShow(); // fica disponível quando a pessoa voltar do WhatsApp
  chatRecordHandoff().catch(() => {
    const history = document.getElementById('chat-history');
    const notice = document.createElement('p');
    notice.className = 'text-sm p-3 rounded-xl bg-amber-50 text-amber-900';
    notice.textContent = 'O WhatsApp foi aberto, mas o pedido não entrou na fila do painel. Você pode continuar pelo WhatsApp. ';
    const retry = document.createElement('button'); retry.textContent = 'Tentar registrar novamente';
    retry.className = 'underline font-semibold';
    retry.onclick = async () => {
      retry.disabled = true;
      try { await chatRecordHandoff(); notice.textContent = 'Pedido registrado na fila de atendimento.'; }
      catch (e) { retry.disabled = false; }
    };
    notice.appendChild(retry); history.appendChild(notice);
  });
}
