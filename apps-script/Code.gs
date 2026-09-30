// =======================================================================
// CONFIGURAÇÕES
// =======================================================================
const scriptProperties = PropertiesService.getScriptProperties();
const GEMINI_API_KEY  = scriptProperties.getProperty('GEMINI_API_KEY');
const GEMINI_MODELOS = [
  'gemini-3.1-flash-lite',   // primário
  'gemini-3.5-flash',        // fallback 1: mais capaz
  'gemini-3.1-pro-preview'   // fallback 2: reserva confiável
];

const SUPABASE_KEY    = scriptProperties.getProperty('SUPABASE_KEY');
const SUPABASE_URL    = scriptProperties.getProperty('SUPABASE_URL');

const FRONTEND_SECRET = scriptProperties.getProperty('FRONTEND_SECRET') || 'apollo-secret-2026';

const LIMITE_DIARIO    = 25;
const AVISO_LIMITE_EM  = 15;
const DIAS_EXPIRACAO   = 60;
const EMAIL_NOTIFICACAO = 'apollovoleibol@gmail.com';
const MAX_HISTORY_MSGS = 12;
const CACHE_KEY_QUADRO = 'quadro_equipes_v3';
const CACHE_TTL_QUADRO = 1800;
const CACHE_KEY_AGENDA_PUBLICA = 'agenda_publica_v1';
const CACHE_TTL_AGENDA_PUBLICA = 300; // 5 min — landing page pública, tráfego de visitantes sem login
const FETCH_DEADLINE   = 10;

const TURMAS_MENORES = [
  'escolinha a', 'escolinha b', 'escolinha c',
  'pré-equipe', 'pre-equipe',
  'equipe feminino', 'equipe masculino'
];

const PALAVRAS_INVALIDAS_NOME = [
  'sim', 'não', 'nao', 'ok', 'confirmo', 'pode ser', 'pode', 'tudo certo',
  'certo', 'correto', 'isso', 'exato', 'claro', 'com certeza', 'confirmado',
  'yes', 'yep', 's', 'n', 'beleza', 'ótimo', 'otimo', 'perfeito'
];

var FASE = {
  INICIO        : 'inicio',
  CONFIRMACAO   : 'confirmacao',
  CONCLUIDO     : 'concluido',
  REAGENDAMENTO : 'reagendamento'
};

// =======================================================================
// WEB APP ENTRY POINTS
// =======================================================================
function doGet(e) {
  var action = (e && e.parameter) ? e.parameter.action : null;
  if (!action) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', message: 'API Apollo Voleibol online.' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return _processarRequisicao(e.parameter);
}

function doPost(e) {
  return _processarRequisicao((e && e.parameter) ? e.parameter : {});
}

function _processarRequisicao(params) {
  try {
    var secret     = params.secret;
    var action     = params.action;
    var payloadStr = params.payload;

    if (secret !== FRONTEND_SECRET) {
      return ContentService
        .createTextOutput(JSON.stringify({ sucesso: false, erro: 'Acesso negado: Secret inválido.' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var payload = payloadStr ? JSON.parse(payloadStr) : {};
    var result;

    switch (action) {
      case 'carregarDadosIniciais':
        result = startChatWithMetrics(payload.whatsapp, payload.name);
        break;
      case 'processChatMessage':
        result = processChatWithMetrics(payload.history, payload.userData, payload.metrics, payload.requestId);
        break;
      case 'registrarEventoAtendimento':
        result = registerChatClientEvent(payload);
        break;
      case 'processarReagendamentoDireto':
        result = processarReagendamentoDireto(payload.idAgendamento, payload.whatsapp, payload.novaDataISO);
        break;
      case 'processarCadastro':
        result = processarCadastro(payload.formData);
        break;
      case 'obterAgendaPublica':
        result = obterAgendaPublica();
        break;
      default:
        throw new Error('Ação desconhecida pela API: ' + action);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ sucesso: true, dados: result }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('[ERRO _processarRequisicao] ' + error);
    return ContentService
      .createTextOutput(JSON.stringify({ sucesso: false, erro: error.toString(), debug: error.debugInfo || null }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// =======================================================================
// FUNÇÃO CENTRALIZADA DA API DO GEMINI
// =======================================================================
function chamarGemini(payload) {
  var ultimoErro = null;

  for (var i = 0; i < GEMINI_MODELOS.length; i++) {
    var modelo = GEMINI_MODELOS[i];
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/'
              + modelo + ':generateContent?key=' + GEMINI_API_KEY;

    try {
      var response = UrlFetchApp.fetch(url, {
        method        : 'post',
        contentType   : 'application/json',
        payload       : JSON.stringify(payload),
        muteHttpExceptions: true,
        deadline      : 30
      });

      var code = response.getResponseCode();
      Logger.log('[Gemini] Modelo: ' + modelo + ' | HTTP: ' + code);

      if (code === 503 || code === 429 || code === 500) {
        ultimoErro = 'HTTP ' + code + ' em ' + modelo + ': ' + response.getContentText();
        Logger.log('[Gemini] Fallback ativado. ' + ultimoErro);
        continue;
      }

      if (code >= 400) {
        throw new Error('Erro Gemini API (' + code + '): ' + response.getContentText());
      }

      if (i > 0) Logger.log('[Gemini] Respondido pelo fallback: ' + modelo);
      return JSON.parse(response.getContentText());

    } catch (e) {
      if (e.message && e.message.indexOf('Erro Gemini API') === 0) throw e;
      ultimoErro = e.toString();
      Logger.log('[Gemini] Exceção no modelo ' + modelo + ': ' + ultimoErro);
    }
  }

  throw new Error('Todos os modelos Gemini falharam. Último erro: ' + ultimoErro);
}

// =======================================================================
// CARREGAMENTO INICIAL
// =======================================================================
function carregarDadosIniciais(whatsapp) {
  var agendamento  = obterAgendamentoAtivo(whatsapp);
  var isCadastrado = verificarCadastroAtleta(whatsapp);
  var dadosChat    = buscarDadosChatSupabase(whatsapp);

  var statusTryout = agendamento ? agendamento.status : 'PENDING';
  if (agendamento && agendamento.target_team) {
    agendamento.detalhes = buscarDetalhesEquipeDoSupabase(agendamento.target_team);
  }

  return {
    history      : dadosChat.history,
    agendamento  : agendamento,
    fase         : dadosChat.fase,
    statusTryout : statusTryout,
    isCadastrado : isCadastrado
  };
}

function buscarDadosChatSupabase(whatsapp) {
  try {
    var url = SUPABASE_URL + '/rest/v1/chatlogs?whatsapp=eq.' + encodeURIComponent(whatsapp) + '&select=history,fase&limit=1';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (r && r.length > 0) return { history: r[0].history || null, fase: r[0].fase || FASE.INICIO };
  } catch(e) { Logger.log('[ERRO buscarDadosChatSupabase] ' + e); }
  return { history: null, fase: FASE.INICIO };
}

function buscarDadosChatlogs(whatsapp, hoje) {
  try {
    var url = SUPABASE_URL + '/rest/v1/chatlogs?whatsapp=eq.' + encodeURIComponent(whatsapp) + '&select=fase,messages_today,date_today&limit=1';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (r && r.length > 0) {
      return {
        fase         : r[0].fase || FASE.INICIO,
        mensagensHoje: (r[0].date_today && r[0].date_today.substring(0, 10) === hoje)
                       ? (r[0].messages_today || 0) : 0
      };
    }
  } catch(e) { Logger.log('[ERRO buscarDadosChatlogs] ' + e); }
  return { fase: FASE.INICIO, mensagensHoje: 0 };
}

// O campo de WhatsApp do login aplica máscara "(DD) NNNNN-NNNN" antes de
// enviar ao backend, mas registros criados/editados fora do chatbot (ex.:
// painel de gestão/aprovação da peneira) podem gravar o telefone só com
// dígitos, com ou sem o código do país (55). Por isso a busca por telefone
// NUNCA usa igualdade exata no banco — normaliza os dois lados (só dígitos,
// sem DDI) e compara em memória; senão um "eq." exato nunca encontra o
// registro do candidato aprovado e o app cai no chat em vez de abrir a
// jornada/cadastro.
function apenasDigitos(valor) {
  return (valor || '').toString().replace(/\D/g, '');
}

function normalizarTelefoneComparavel(valor) {
  var d = apenasDigitos(valor);
  if (d.length > 11 && d.substring(0, 2) === '55') d = d.substring(2);
  return d;
}

function verificarCadastroAtleta(whatsapp) {
  try {
    var r = _buscarAthletesPorTelefone(whatsapp);
    return !!(r && r.length > 0);
  } catch(e) { Logger.log('[ERRO verificarCadastroAtleta] ' + e); }
  return false;
}

function _buscarAthletesPorTelefone(telefone) {
  var alvo = normalizarTelefoneComparavel(telefone);
  if (!alvo) return null;
  var url = SUPABASE_URL + '/rest/v1/athletes?select=id,phone';
  var r = JSON.parse(UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
    muteHttpExceptions: true, deadline: FETCH_DEADLINE
  }).getContentText());
  if (!r || !r.length) return null;
  var achados = r.filter(function(a) { return normalizarTelefoneComparavel(a.phone) === alvo; });
  return achados.length > 0 ? achados : null;
}

// =======================================================================
// DETALHES DE EQUIPE — SUPABASE (substitui buscarDetalhesEquipeDaPlanilha)
// =======================================================================
function buscarDetalhesEquipeDoSupabase(nomeEquipeBusca) {
  try {
    var url = SUPABASE_URL + '/rest/v1/teams' +
      '?select=id,name,training_schedule,training_locations(address),team_coaches(is_head,profiles(full_name,phone))' +
      '&is_active=eq.true';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (!r || !r.length) return null;

    var nomeNorm = (nomeEquipeBusca || '').toLowerCase().replace('equipe ', '').trim();
    var equipe = null;
    for (var i = 0; i < r.length; i++) {
      var nomePlNorm = (r[i].name || '').toLowerCase().replace('equipe ', '').trim();
      if (nomePlNorm.includes(nomeNorm) || nomeNorm.includes(nomePlNorm)) { equipe = r[i]; break; }
    }
    if (!equipe) return null;

    var headCoach = null;
    if (equipe.team_coaches && equipe.team_coaches.length > 0) {
      for (var c = 0; c < equipe.team_coaches.length; c++) {
        if (equipe.team_coaches[c].is_head && equipe.team_coaches[c].profiles) {
          headCoach = equipe.team_coaches[c].profiles; break;
        }
      }
      if (!headCoach && equipe.team_coaches[0].profiles) headCoach = equipe.team_coaches[0].profiles;
    }

    var proximasDatas = gerarProximasDatasAgendamento(equipe.id);
    var datasFuturas = proximasDatas
      .filter(function(d) { return d !== '-'; })
      .map(function(display) { return { display: display, iso: null }; });

    var coachPhone = headCoach ? (headCoach.phone || '') : '';
    var coachWA = coachPhone.replace(/\D/g, '');

    return {
      endereco       : equipe.training_locations ? equipe.training_locations.address : '',
      tecnico        : headCoach ? headCoach.full_name : '',
      coach_whatsapp : coachWA.length >= 8 ? coachWA : '',
      proximas_datas : datasFuturas
    };
  } catch(e) { Logger.log('[ERRO buscarDetalhesEquipeDoSupabase] ' + e); return null; }
}

// =======================================================================
// NORMALIZAÇÃO
// =======================================================================
function normalizarDadosAgendamento(equipeNome) {
  try {
    var url = SUPABASE_URL + '/rest/v1/teams?select=name,training_locations(address)&is_active=eq.true';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (!r || !r.length) return null;
    var nomeNorm = (equipeNome || '').toLowerCase().replace('equipe ', '').trim();
    for (var i = 0; i < r.length; i++) {
      var nomePlNorm = (r[i].name || '').toLowerCase().replace('equipe ', '').trim();
      if (nomePlNorm.includes(nomeNorm) || nomeNorm.includes(nomePlNorm)) {
        return { equipe: r[i].name, local: r[i].training_locations ? r[i].training_locations.address : '' };
      }
    }
  } catch(e) { Logger.log('[ERRO normalizarDadosAgendamento] ' + e); }
  return null;
}

// =======================================================================
// UTILITÁRIOS E VALIDAÇÃO
// =======================================================================
function processarReagendamentoDireto(idAgendamento, whatsapp, novaDataISO) {
  try {
    var hoje = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');
    var agendamento = obterAgendamentoAtivo(whatsapp);
    if (!agendamento || agendamento.id !== idAgendamento)
      return { sucesso: false, erro: 'Agendamento não encontrado.' };
    var qtd = agendamento.reschedule_count || 0;
    var ultimoReag = agendamento.last_rescheduled_at || null;
    if (qtd > 0 && ultimoReag) {
      var diasDesde = Math.floor((new Date(hoje) - new Date(ultimoReag)) / 86400000);
      if (diasDesde < 30)
        return { sucesso: false, erro: 'Reagendamento disponível em ' + (30 - diasDesde) + ' dia(s).' };
    }
    var salvo = atualizarAgendamentoExistente(
      { id: idAgendamento, equipe: agendamento.target_team, data: novaDataISO, local: agendamento.target_location },
      qtd, hoje
    );
    return { sucesso: salvo };
  } catch (e) {
    Logger.log('[ERRO processarReagendamentoDireto] ' + e);
    return { sucesso: false, erro: 'Erro interno ao processar reagendamento.' };
  }
}

function validarNomeMenor(nomeEquipe, nomeMenor) {
  var equipeNorm = (nomeEquipe || '').toLowerCase().trim();
  var ehTurmaMenor = TURMAS_MENORES.some(function(t) {
    return equipeNorm.includes(t) || t.includes(equipeNorm.replace('equipe ', '').trim());
  });
  if (!ehTurmaMenor) return { valido: true };
  if (!nomeMenor || nomeMenor.toString().trim() === '') return { valido: false, motivo: 'nome_menor ausente' };
  var nomeNorm = nomeMenor.toString().trim().toLowerCase();
  if (PALAVRAS_INVALIDAS_NOME.indexOf(nomeNorm) !== -1) return { valido: false, motivo: 'palavra inválida' };
  var palavras = nomeNorm.split(/\s+/).filter(function(p) { return p.length > 0; });
  if (palavras.length < 2) return { valido: false, motivo: 'sem sobrenome' };
  return { valido: true };
}

function sanitizarDataParaISO(dataStr) {
  if (!dataStr) return dataStr;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dataStr)) return dataStr.substring(0, 16);
  var meses = { 'janeiro':1,'fevereiro':2,'marco':3,'abril':4,'maio':5,'junho':6,
                'julho':7,'agosto':8,'setembro':9,'outubro':10,'novembro':11,'dezembro':12 };
  var normalizado = dataStr.toLowerCase()
    .replace(/ç/g,'c').replace(/ã/g,'a').replace(/á/g,'a')
    .replace(/é/g,'e').replace(/ê/g,'e').replace(/ó/g,'o');
  var match = normalizado.match(/(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?(?:[^0-9]*(\d{1,2})(?::|h)?(\d{2})?)?/);
  if (match) {
    var dia = parseInt(match[1], 10), mes = meses[match[2]],
        ano  = match[3] ? parseInt(match[3], 10) : new Date().getFullYear(),
        hora = match[4] ? parseInt(match[4], 10) : 0,
        min  = match[5] ? parseInt(match[5], 10) : 0;
    if (mes) return Utilities.formatDate(new Date(ano, mes - 1, dia, hora, min, 0), 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm");
  }
  var matchSlash = normalizado.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:às|-)?\s*(\d{1,2})(?::|h)?(\d{2})?)?/);
  if (matchSlash) {
    var horaS = matchSlash[4] ? parseInt(matchSlash[4], 10) : 0,
        minS  = matchSlash[5] ? parseInt(matchSlash[5], 10) : 0;
    return Utilities.formatDate(
      new Date(parseInt(matchSlash[3]), parseInt(matchSlash[2]) - 1, parseInt(matchSlash[1]), horaS, minS, 0),
      'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm"
    );
  }
  return dataStr;
}

// =======================================================================
// SUPABASE — TRYOUTS
// =======================================================================
function obterAgendamentoAtivo(whatsapp) {
  // Exclui apenas cancelados. Qualquer outro status (PENDING, CONFIRMED,
  // IN_EVALUATION, IN_REGISTRATION, TECNOFIT...) deve seguir sendo tratado
  // como agendamento ativo para que o chatbot roteie a tela correta (countdown/timeline).
  try {
    return _buscarTryoutPorTelefone(whatsapp);
  } catch(e) { Logger.log('[ERRO obterAgendamentoAtivo] ' + e); return null; }
}

function _buscarTryoutPorTelefone(telefone) {
  var alvo = normalizarTelefoneComparavel(telefone);
  if (!alvo) return null;
  // Sem filtro de igualdade por telefone no banco (formatos variam entre
  // quem gravou o registro) — busca os mais recentes não-cancelados e
  // compara o telefone normalizado em memória.
  var url = SUPABASE_URL + '/rest/v1/tryouts?status=not.in.(CANCELLED,CANCELED)&order=created_at.desc&limit=200';
  var r = JSON.parse(UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
    muteHttpExceptions: true, deadline: FETCH_DEADLINE
  }).getContentText());
  if (!r || !r.length) return null;
  for (var i = 0; i < r.length; i++) {
    if (normalizarTelefoneComparavel(r[i].whatsapp_phone) === alvo) return r[i];
  }
  return null;
}

// -----------------------------------------------------------------------
// NOVA FUNÇÃO: Buscar o UUID da equipe pelo nome
// -----------------------------------------------------------------------
function buscarTeamId(equipeNome) {
  try {
    var url = SUPABASE_URL + '/rest/v1/teams?select=id,name&is_active=eq.true';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (!r || !r.length) return null;
    var nomeNorm = (equipeNome || '').toLowerCase().trim();
    for (var i = 0; i < r.length; i++) {
      var n = (r[i].name || '').toLowerCase().trim();
      if (n === nomeNorm || n.includes(nomeNorm) || nomeNorm.includes(n)) return r[i].id;
    }
  } catch(e) { Logger.log('[ERRO buscarTeamId] ' + e); }
  return null;
}

function registrarAgendamento(whatsapp, nome, data) {
  var teamId = buscarTeamId(data.equipe);
  var payload = JSON.stringify({
    whatsapp_phone: whatsapp, name: nome, target_team: data.equipe,
    scheduled_at: data.data, target_location: data.local,
    status: 'CONFIRMED', reschedule_count: 0, minor_name: data.nome_menor || null,
    team_id: teamId
  });
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/tryouts', {
      method: 'post',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      payload: payload, muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    var code = res.getResponseCode();
    if (code >= 400) {
      Logger.log('[ERRO registrarAgendamento] HTTP ' + code + ' — ' + res.getContentText());
    }
    if (code < 400 && CHAT_METRICS_CONTEXT) {
      try {
        var created = JSON.parse(res.getContentText() || '[]');
        if (created[0] && created[0].id) metricsSafeEvent_(CHAT_METRICS_CONTEXT, 'booking', { tryout: created[0].id });
      } catch (metricsError) { Logger.log('[METRICS_ERROR] booking response could not be read'); }
    }
    return code < 400;
  } catch(e) { Logger.log('[ERRO registrarAgendamento] ' + e); return false; }
}

function atualizarAgendamentoExistente(novaData, qtdAtual, hoje) {
  try {
    var novoTeamId = buscarTeamId(novaData.equipe);

    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/tryouts?id=eq.' + novaData.id, {
      method: 'patch',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      payload: JSON.stringify({
        target_team: novaData.equipe, scheduled_at: novaData.data, target_location: novaData.local,
        team_id: novoTeamId,
        reschedule_count: (qtdAtual || 0) + 1, last_rescheduled_at: hoje
      }),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    return res.getResponseCode() < 400;
  } catch(e) { Logger.log('[ERRO atualizarAgendamentoExistente] ' + e); return false; }
}

// =======================================================================
// SUPABASE — CHATLOGS
// =======================================================================
function salvarHistoricoSupabase(whatsapp, nome, historyObj, mensagensHoje, dateToday, fase) {
  try {
    UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/chatlogs', {
      method: 'post',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates'
      },
      payload: JSON.stringify({
        whatsapp: whatsapp, nome: nome, history: historyObj,
        messages_today: mensagensHoje || 0,
        date_today     : dateToday || Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd'),
        updated_at     : new Date().toISOString(),
        fase           : fase || FASE.INICIO
      }),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
  } catch(e) { Logger.log('[ERRO salvarHistoricoSupabase] ' + e); }
}

function atualizarFaseSupabase(whatsapp, fase) {
  try {
    UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/chatlogs?whatsapp=eq.' + encodeURIComponent(whatsapp), {
      method: 'patch',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      payload: JSON.stringify({ fase: fase, updated_at: new Date().toISOString() }),
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
  } catch(e) { Logger.log('[ERRO atualizarFaseSupabase] ' + e); }
}

// =======================================================================
// E-MAIL
// =======================================================================
function enviarEmailAgendamento(dadosBooking, nomeResponsavel, whatsapp) {
  try {
    var assunto = '🗓 Alerta de Agendamento — ' + (dadosBooking.equipe || '') + ' — ' + nomeResponsavel;
    var numeroLimpo = whatsapp.replace(/\D/g, '');
    if (numeroLimpo.length === 10 || numeroLimpo.length === 11) numeroLimpo = '55' + numeroLimpo;
    var waIconHtml = "<a href='https://wa.me/" + numeroLimpo + "' target='_blank' style='text-decoration:none;color:#333;display:inline-flex;align-items:center;'>" + whatsapp + "<img src='https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg' width='16' height='16' style='margin-left:8px;vertical-align:middle;' alt='WhatsApp'></a>";
    var dataFormatada = dadosBooking.data || '-';
    if (dadosBooking.data && dadosBooking.data.includes('T')) {
      var partes = dadosBooking.data.split('T'), d = partes[0].split('-');
      dataFormatada = d[2] + '/' + d[1] + '/' + d[0];
      if (partes[1] && partes[1] !== '00:00') dataFormatada += ' às ' + partes[1];
    }
    var td = "border-bottom:1px solid #ddd;padding:10px 0;color:#333;";
    var mensagem  = "<p style='font-family:Arial,sans-serif;font-size:16px;color:#333;'>Olá!</p>";
    mensagem += "<p style='font-family:Arial,sans-serif;font-size:16px;color:#333;'>Um novo agendamento foi confirmado pelo Assistente Virtual Apollo:</p><br>";
    mensagem += "<table style='border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;'>";
    mensagem += "<tr><th style='border-bottom:2px solid #ee453b;text-align:left;padding:8px 0;color:#ee453b;width:30%;'>DADO</th><th style='border-bottom:2px solid #ee453b;text-align:left;padding:8px 0;color:#ee453b;width:70%;'>INFORMAÇÃO</th></tr>";
    mensagem += "<tr><td style='" + td + "'><strong>Responsável</strong></td><td style='" + td + "'>" + nomeResponsavel + "</td></tr>";
    mensagem += "<tr><td style='" + td + "'><strong>WhatsApp</strong></td><td style='" + td + "'>" + waIconHtml + "</td></tr>";
    mensagem += "<tr><td style='" + td + "'><strong>Equipe</strong></td><td style='" + td + "'>" + (dadosBooking.equipe || '-') + "</td></tr>";
    mensagem += "<tr><td style='" + td + "'><strong>Data/Horário</strong></td><td style='" + td + "'>" + dataFormatada + "</td></tr>";
    mensagem += "<tr><td style='" + td + "'><strong>Local</strong></td><td style='" + td + "'>" + (dadosBooking.local || '-') + "</td></tr>";
    if (dadosBooking.nome_menor) mensagem += "<tr><td style='" + td + "'><strong>Atleta (Menor)</strong></td><td style='" + td + "'>" + dadosBooking.nome_menor + "</td></tr>";
    mensagem += "</table><br><p style='font-family:Arial,sans-serif;font-size:14px;color:#555;'><i>To the moon and beyond.</i></p><hr style='border:0;border-top:1px solid #ccc;'>";
    mensagem += "<table style='width:100%;max-width:400px;border-collapse:collapse;margin:20px 0;'><tr><td style='width:30%;text-align:left;vertical-align:middle;'><img src='https://drive.google.com/uc?export=view&id=1WBV8jkaSIoQoW5Y3OorkaV_7uIbLUBgj' alt='Logo' style='width:100px;height:auto;display:block;'></td><td style='width:70%;text-align:left;vertical-align:middle;padding-left:20px;'><p style='font-family:Arial,sans-serif;font-size:16px;color:#333333;margin:0;'>Assistente Virtual Apollo</p></td></tr></table>";
    GmailApp.sendEmail(EMAIL_NOTIFICACAO, assunto, '', { htmlBody: mensagem });
  } catch (e) { Logger.log('[ERRO enviarEmailAgendamento] ' + e); }
}

// =======================================================================
// EXTRAÇÃO DE QUADRO DE EQUIPES — SUPABASE
// =======================================================================
function obterQuadroDoSupabase() {
  try {
    var cached = CacheService.getScriptCache().get(CACHE_KEY_QUADRO);
    if (cached && cached !== 'Nenhuma equipe cadastrada.' && cached.indexOf('EQUIPE:') !== -1) return cached;
  } catch(e) {}

  try {
    var url = SUPABASE_URL + '/rest/v1/teams' +
      '?select=id,name,description,training_schedule,' +
      'training_locations(address),' +
      'team_coaches(is_head,profiles(full_name,phone))' +
      '&is_active=eq.true&available_for_booking=eq.true&order=name.asc';
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    var rawText = resp.getContentText();
    var httpCode = resp.getResponseCode();
    Logger.log('[obterQuadroDoSupabase] HTTP ' + httpCode + ' | corpo: ' + rawText.substring(0, 600));
    var equipes = JSON.parse(rawText);
    if (!Array.isArray(equipes) || equipes.length === 0) {
      Logger.log('[obterQuadroDoSupabase] Resposta não é array ou está vazia. Corpo: ' + rawText.substring(0, 400));
      return 'Nenhuma equipe cadastrada.';
    }

    // Buscar todas as datas bloqueadas dos próximos 90 dias de uma só vez
    var hoje = new Date();
    var fim90 = new Date(hoje); fim90.setDate(fim90.getDate() + 90);
    var hojeStr = Utilities.formatDate(hoje, 'America/Sao_Paulo', 'yyyy-MM-dd');
    var fimStr  = Utilities.formatDate(fim90, 'America/Sao_Paulo', 'yyyy-MM-dd');
    var allBlocked = {};
    try {
      var blockedUrl = SUPABASE_URL + '/rest/v1/team_unavailable_dates' +
        '?date=gte.' + hojeStr + '&date=lte.' + fimStr + '&select=team_id,date';
      var br = JSON.parse(UrlFetchApp.fetch(blockedUrl, {
        method: 'get',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        muteHttpExceptions: true, deadline: FETCH_DEADLINE
      }).getContentText());
      if (br && br.length) br.forEach(function(b) {
        if (!allBlocked[b.team_id]) allBlocked[b.team_id] = [];
        allBlocked[b.team_id].push(b.date);
      });
    } catch(e) { Logger.log('[WARN obterQuadroDoSupabase] blocked dates: ' + e); }

    var diasSemana = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
    var texto = '';

    for (var i = 0; i < equipes.length; i++) {
      var eq = equipes[i];

      var headCoach = null;
      if (eq.team_coaches && eq.team_coaches.length > 0) {
        for (var c = 0; c < eq.team_coaches.length; c++) {
          if (eq.team_coaches[c].is_head && eq.team_coaches[c].profiles) {
            headCoach = eq.team_coaches[c].profiles; break;
          }
        }
        if (!headCoach && eq.team_coaches[0].profiles) headCoach = eq.team_coaches[0].profiles;
      }

      var horarios = [];
      if (eq.training_schedule && eq.training_schedule.length > 0) {
        eq.training_schedule.forEach(function(s) {
          horarios.push(diasSemana[s.day] + ' ' + s.start + ' às ' + s.end);
        });
      }

      var datas = calcularProximasDatas(eq.training_schedule || [], allBlocked[eq.id] || []);
      var datasValidas = datas.filter(function(d) { return d !== '-'; });

      texto += 'EQUIPE: ' + eq.name + '\n' +
               'DESCRIÇÃO: ' + (eq.description || '') + '\n' +
               'LOCAL: ' + (eq.training_locations ? eq.training_locations.address : '') + '\n' +
               'TÉCNICO: ' + (headCoach ? headCoach.full_name : '') +
               ' | TELEFONE: ' + (headCoach ? (headCoach.phone || '') : '') + '\n' +
               'HORÁRIOS: ' + (horarios.join(' / ') || '') + '\n' +
               'DATAS DISPONÍVEIS: ' + (datasValidas.length ? datasValidas.join(' / ') : 'A definir') + '\n---\n';
    }

    var resultado = texto || 'Nenhuma equipe cadastrada.';
    try { CacheService.getScriptCache().put(CACHE_KEY_QUADRO, resultado, CACHE_TTL_QUADRO); } catch(e) {}
    return resultado;
  } catch(e) {
    Logger.log('[ERRO obterQuadroDoSupabase] ' + e);
    return 'ALERTA: instabilidade ao acessar equipes.';
  }
}

// =======================================================================
// AGENDA PÚBLICA (landing page apollovoleibol.com.br)
// =======================================================================
// Ação pública e somente-leitura: devolve só dados institucionais (equipe,
// horário, local, competição) — NUNCA telefone, CPF, nome de atleta ou
// qualquer outro dado pessoal. Chamada por visitantes sem login, então o
// resultado fica em cache por poucos minutos para não sobrecarregar o
// Supabase com tráfego público.
function obterAgendaPublica() {
  try {
    var cached = CacheService.getScriptCache().get(CACHE_KEY_AGENDA_PUBLICA);
    if (cached) return JSON.parse(cached);
  } catch(e) {}

  try {
    var teamsUrl = SUPABASE_URL + '/rest/v1/teams' +
      '?select=id,name,category,gender,age_min,age_max,description,color_hex,training_schedule,training_locations(name,address)' +
      '&is_active=eq.true&order=name.asc';
    var teamsResp = UrlFetchApp.fetch(teamsUrl, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    var teamsRaw = JSON.parse(teamsResp.getContentText());
    var teams = Array.isArray(teamsRaw) ? teamsRaw.map(function(t) {
      return {
        id: t.id, name: t.name, category: t.category, gender: t.gender,
        age_min: t.age_min, age_max: t.age_max, description: t.description || '',
        color_hex: t.color_hex || '#6366F1',
        training_schedule: t.training_schedule || [],
        location_name: t.training_locations ? t.training_locations.name : null,
        location_address: t.training_locations ? t.training_locations.address : null
      };
    }) : [];

    // Competições de ~1 semana atrás (para não sumir instantaneamente após o
    // horário) até 90 dias no futuro. Cancelada não interessa ao público.
    var hoje = new Date();
    var desde = new Date(hoje); desde.setDate(desde.getDate() - 7);
    var ate = new Date(hoje); ate.setDate(ate.getDate() + 90);
    var desdeStr = Utilities.formatDate(desde, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm:ss");
    var ateStr = Utilities.formatDate(ate, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm:ss");

    var compUrl = SUPABASE_URL + '/rest/v1/competitions' +
      '?select=id,name,opponent,scheduled_at,venue_name,team_id,status,competition_type' +
      '&scheduled_at=gte.' + encodeURIComponent(desdeStr) +
      '&scheduled_at=lte.' + encodeURIComponent(ateStr) +
      '&status=neq.cancelled&order=scheduled_at.asc';
    var compResp = UrlFetchApp.fetch(compUrl, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    var competitions = JSON.parse(compResp.getContentText());
    if (!Array.isArray(competitions)) competitions = [];

    var resultado = { teams: teams, competitions: competitions, geradoEm: new Date().toISOString() };
    try { CacheService.getScriptCache().put(CACHE_KEY_AGENDA_PUBLICA, JSON.stringify(resultado), CACHE_TTL_AGENDA_PUBLICA); } catch(e) {}
    return resultado;
  } catch(e) {
    Logger.log('[ERRO obterAgendaPublica] ' + e);
    return { teams: [], competitions: [], erro: 'Não foi possível carregar a agenda no momento.' };
  }
}

function invalidarCacheQuadro() {
  try { CacheService.getScriptCache().remove(CACHE_KEY_QUADRO); Logger.log('Cache invalidado.'); } catch(e) {}
}

// =======================================================================
// DIAGNÓSTICO — Executar manualmente no editor do GAS para depurar
// =======================================================================
function diagnosticarConexaoSupabase() {
  Logger.log('=== DIAGNÓSTICO SUPABASE ===');
  Logger.log('SUPABASE_URL: ' + SUPABASE_URL);
  Logger.log('SUPABASE_KEY definida: ' + (SUPABASE_KEY ? 'SIM (' + SUPABASE_KEY.substring(0, 20) + '...)' : 'NÃO — verifique Script Properties!'));

  // 1. Teste simples: listar equipes sem nested selects
  try {
    var r1 = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/teams?select=id,name&is_active=eq.true&limit=3', {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    Logger.log('[Teste 1 — teams simples] HTTP ' + r1.getResponseCode() + ' | ' + r1.getContentText().substring(0, 300));
  } catch(e) { Logger.log('[Teste 1 ERRO] ' + e); }

  // 2. Teste com training_locations embutido
  try {
    var r2 = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/teams?select=id,name,training_locations(address)&is_active=eq.true&limit=3', {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    Logger.log('[Teste 2 — training_locations embed] HTTP ' + r2.getResponseCode() + ' | ' + r2.getContentText().substring(0, 300));
  } catch(e) { Logger.log('[Teste 2 ERRO] ' + e); }

  // 3. Teste com team_coaches embutido
  try {
    var r3 = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/teams?select=id,name,team_coaches(is_head,profiles(full_name))&is_active=eq.true&limit=3', {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    Logger.log('[Teste 3 — team_coaches embed] HTTP ' + r3.getResponseCode() + ' | ' + r3.getContentText().substring(0, 300));
  } catch(e) { Logger.log('[Teste 3 ERRO] ' + e); }

  // 4. Teste team_unavailable_dates
  try {
    var r4 = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/team_unavailable_dates?select=id&limit=1', {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true
    });
    Logger.log('[Teste 4 — team_unavailable_dates] HTTP ' + r4.getResponseCode() + ' | ' + r4.getContentText().substring(0, 200));
  } catch(e) { Logger.log('[Teste 4 ERRO] ' + e); }

  // 5. Cache atual
  try {
    var cacheVal = CacheService.getScriptCache().get(CACHE_KEY_QUADRO);
    Logger.log('[Cache atual] ' + (cacheVal ? cacheVal.substring(0, 200) : '(vazio)'));
  } catch(e) {}

  Logger.log('=== FIM DO DIAGNÓSTICO ===');
}

// Calcula as 3 próximas datas de treino a partir de training_schedule JSONB e lista de datas bloqueadas.
// Não faz chamadas de rede — recebe os dados já carregados pelo chamador.
function calcularProximasDatas(trainingSchedule, blockedDates) {
  if (!trainingSchedule || trainingSchedule.length === 0) return ['-', '-', '-'];
  var mapaHorarios = {};
  trainingSchedule.forEach(function(s) { mapaHorarios[s.day] = { start: s.start, end: s.end }; });

  var meses = ['janeiro','fevereiro','março','abril','maio','junho',
               'julho','agosto','setembro','outubro','novembro','dezembro'];
  var agora = new Date();
  var dataCalculo = new Date(); dataCalculo.setHours(0,0,0,0);
  var proximasDatas = []; var contador = 0;

  while (proximasDatas.length < 3 && contador < 90) {
    var dia = dataCalculo.getDay();
    var dataStr = Utilities.formatDate(dataCalculo, 'America/Sao_Paulo', 'yyyy-MM-dd');
    if (mapaHorarios[dia] && blockedDates.indexOf(dataStr) === -1) {
      var info = mapaHorarios[dia];
      var partes = info.start.split(':');
      var momentoTreino = new Date(dataCalculo.getTime());
      momentoTreino.setHours(parseInt(partes[0]), parseInt(partes[1]), 0, 0);
      if ((momentoTreino - agora) / 3600000 >= 12) {
        var startDisp = info.start.replace(':', 'h').replace(/^0(\d)/, '$1');
        var endDisp   = info.end.replace(':', 'h').replace(/^0(\d)/, '$1');
        proximasDatas.push(dataCalculo.getDate() + ' de ' + meses[dataCalculo.getMonth()] + ', ' + startDisp + ' às ' + endDisp);
      }
    }
    dataCalculo.setDate(dataCalculo.getDate() + 1);
    contador++;
  }
  while (proximasDatas.length < 3) proximasDatas.push('-');
  return proximasDatas;
}

// Versão pública usada para um único time (ex: buscarDetalhesEquipeDoSupabase, reagendamento).
function gerarProximasDatasAgendamento(teamId) {
  try {
    var url = SUPABASE_URL + '/rest/v1/teams?id=eq.' + teamId + '&select=training_schedule';
    var r = JSON.parse(UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      muteHttpExceptions: true, deadline: FETCH_DEADLINE
    }).getContentText());
    if (!r || !r.length) return ['-', '-', '-'];

    var hoje = new Date(); var fim90 = new Date(hoje); fim90.setDate(fim90.getDate() + 90);
    var blockedUrl = SUPABASE_URL + '/rest/v1/team_unavailable_dates?team_id=eq.' + teamId +
      '&date=gte.' + Utilities.formatDate(hoje, 'America/Sao_Paulo', 'yyyy-MM-dd') +
      '&date=lte.' + Utilities.formatDate(fim90, 'America/Sao_Paulo', 'yyyy-MM-dd') + '&select=date';
    var blocked = [];
    try {
      var br = JSON.parse(UrlFetchApp.fetch(blockedUrl, {
        method: 'get',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        muteHttpExceptions: true, deadline: FETCH_DEADLINE
      }).getContentText());
      if (br && br.length) blocked = br.map(function(b) { return b.date; });
    } catch(e) {}

    return calcularProximasDatas(r[0].training_schedule || [], blocked);
  } catch(e) { Logger.log('[ERRO gerarProximasDatasAgendamento] ' + e); return ['-', '-', '-']; }
}

// =======================================================================
// PROCESSAMENTO DO FORMULÁRIO DE CADASTRO
// =======================================================================
function processarCadastro(formData) {
  // team_id é obrigatório (NOT NULL) na tabela athletes. O frontend já envia
  // esse valor em formData.team_id (ver chatbot-front, fwSubmit()), mas ele
  // nunca era lido aqui — todo cadastro caía em erro de banco (23502 not-null
  // violation) sem isso, mesmo com o restante dos dados corretos. Verificado
  // antes do try/catch genérico para não perder essa mensagem específica.
  if (!formData.team_id) {
    Logger.log('[ERRO processarCadastro] team_id ausente no formData — agendamento sem equipe vinculada.');
    var semTeamId = new Error('Não foi possível identificar a equipe do agendamento. Entre em contato com a administração.');
    semTeamId.debugInfo = { etapa: 'validacao_team_id', formDataRecebido: formData };
    throw semTeamId;
  }
  try {
    // Converte "DD/MM/AAAA" (chatbot-front, campo tipo DATE_BR) para
    // "AAAA-MM-DD", formato aceito pela coluna DATE do Postgres. O front-end
    // já valida que é uma data de calendário real, mas esta API é um
    // endpoint compartilhado — validamos de novo aqui em vez de confiar
    // apenas no cliente (uma data tipo "00/00/0000" chegaria a virar
    // "0000-00-00" e o Postgres rejeitaria com erro 22008, mascarado pelo
    // catch abaixo como "Falha na comunicação com o servidor.").
    var nascimentoBR = formData.nascimento || '';
    var partesData = nascimentoBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    var birthDateISO = null;
    if (partesData) {
      var diaNasc = parseInt(partesData[1], 10), mesNasc = parseInt(partesData[2], 10), anoNasc = parseInt(partesData[3], 10);
      var diasNoMes = new Date(anoNasc, mesNasc, 0).getDate();
      if (mesNasc >= 1 && mesNasc <= 12 && diaNasc >= 1 && diaNasc <= diasNoMes && anoNasc >= 1900) {
        birthDateISO = partesData[3] + '-' + partesData[2] + '-' + partesData[1];
      }
    }

    // A coluna "address" é um texto único, mas o chatbot-front coleta o
    // endereço em campos separados (cep/rua/numero/complemento).
    var enderecoPartes = [];
    if (formData.rua) enderecoPartes.push(formData.rua + (formData.numero ? ', ' + formData.numero : ''));
    if (formData.complemento) enderecoPartes.push(formData.complemento);
    if (formData.cep) enderecoPartes.push('CEP ' + formData.cep);
    var addressFull = enderecoPartes.length ? enderecoPartes.join(' - ') : null;

    // As chaves abaixo devem corresponder aos IDs usados em chatbot-front
    // (fwBuildPages(), index.html). Os IDs numéricos anteriores eram de uma
    // versão antiga baseada em Google Forms e não existem mais no formData
    // enviado pelo front-end atual — todo formData[<id numérico>] resultava
    // em undefined, fazendo full_name (NOT NULL) chegar como null e o
    // INSERT falhar sempre, mascarado pelo catch abaixo como "Falha na
    // comunicação com o servidor.".
    const payload = {
      team_id: formData.team_id,
      full_name: formData.nome_atleta || null, cpf: formData.cpf || null,
      rg: formData.rg || null, birth_date: birthDateISO,
      email: formData.email || null, address: addressFull,
      phone: formData.whatsapp || null, emergency_contact: formData.emergencia || null,
      payment_plan: formData.plano_sel || null,
      payment_bank: formData.banco || null,
      training_days: formData.dias_treino || null,
      height: formData.estatura || null, weight: formData.peso || null,
      anamnesis_restrictions: formData.q1 || null, anamnesis_pain: formData.q2 || null,
      anamnesis_fainting: formData.q3 || null, anamnesis_posture: formData.q4 || null,
      anamnesis_lesion: formData.q5 || null, anamnesis_surgery: formData.q6 || null,
      anamnesis_deficiency: formData.q7 || null, anamnesis_other_activities: formData.q8 || null,
      anamnesis_eating_habits: formData.q9 || null, anamnesis_meals_per_day: formData.q9_1 || null,
      anamnesis_personal_history: formData.q10 || null, anamnesis_continuous_illness: formData.q11 || null,
      anamnesis_diagnostics: formData.q12 || null, anamnesis_family_history: formData.q13 || null,
      anamnesis_medications: formData.q14 || null, anamnesis_observations: formData.q15 || null,
      terms_accepted: !!formData.declaracao_aceite, raw_form_data: formData
    };
    const response = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/athletes', {
      method: "post",
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=minimal" },
      payload: JSON.stringify(payload), muteHttpExceptions: true, deadline: FETCH_DEADLINE
    });
    if (response.getResponseCode() >= 200 && response.getResponseCode() < 300) return { sucesso: true };
    var httpCode = response.getResponseCode();
    var httpBody = response.getContentText();
    Logger.log('[ERRO processarCadastro] HTTP ' + httpCode + ' — ' + httpBody);
    var dbError = new Error('Erro do banco de dados: ' + httpCode);
    // debugInfo viaja até _processarRequisicao() e é devolvido ao front-end no
    // campo "debug" da resposta JSON — sem log do Apps Script acessível por
    // fora (sem projeto GCP vinculado, "clasp logs" não funciona), esse é o
    // único jeito de ver o erro real do Postgres/PostgREST sem acesso ao
    // editor do Apps Script.
    dbError.debugInfo = { etapa: 'insert_athletes', httpCode: httpCode, httpBody: httpBody, payloadEnviado: payload };
    throw dbError;
  } catch (error) {
    Logger.log('[ERRO FATAL processarCadastro] ' + error);
    var erroFinal = new Error("Falha na comunicação com o servidor.");
    erroFinal.debugInfo = error.debugInfo || { etapa: 'exception', mensagem: (error && error.message) || String(error), stack: (error && error.stack) || null };
    throw erroFinal;
  }
}

// =======================================================================
// BACKUP SERVER-SIDE
// =======================================================================
function recuperarAgendamentoDoHistorico(whatsapp, nome, history) {
  var existente = obterAgendamentoAtivo(whatsapp);
  if (existente && (existente.status === 'CONFIRMED' || existente.status === 'PENDING'))
    return { status: 'skip', motivo: 'booking_existente' };

  var trechoHistorico = history.slice(-15).map(function(m) {
    return (m.role === 'model' ? 'Bot: ' : 'Usuário: ') + m.parts[0].text;
  }).join('\n');

  var extractPrompt = 'Extraia os dados do agendamento que o bot e o usuário acabaram de concordar.\n' +
    'Retorne APENAS UM JSON válido:\n{\n"equipe": "Nome completo",\n"data": "YYYY-MM-DDTHH:mm",\n"local": "Endereço",\n"nome_menor": "Nome Sobrenome ou null"\n}\n' +
    'Se os dados estiverem vagos, retorne {"erro": "insuficiente"}.\nChat:\n' + trechoHistorico;

  try {
    var payload = {
      contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1500 }
    };

    var json = chamarGemini(payload);

    var rawText = json.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
    var extracted = JSON.parse(rawText);
    if (extracted.erro || !extracted.equipe || !extracted.data) return { status: 'erro' };

    if (!validarNomeMenor(extracted.equipe, extracted.nome_menor).valido) extracted.nome_menor = null;
    extracted.data = sanitizarDataParaISO(extracted.data);
    var infoExata = normalizarDadosAgendamento(extracted.equipe);
    if (infoExata) { extracted.equipe = infoExata.equipe; extracted.local = infoExata.local; }

    if (registrarAgendamento(whatsapp, nome, extracted)) {
      enviarEmailAgendamento(extracted, nome, whatsapp);
      atualizarFaseSupabase(whatsapp, FASE.CONCLUIDO);
      return { status: 'recuperado' };
    }
  } catch(e) { Logger.log('[ERRO recuperarAgendamentoDoHistorico] ' + e); }
  return { status: 'erro' };
}

// =======================================================================
// PROCESSAMENTO DE MENSAGEM (O CORAÇÃO DO BOT)
// =======================================================================
function processChatMessage(history, userData) {
  const hoje = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd');

  const dadosChat = buscarDadosChatlogs(userData.whatsapp, hoje);
  if (dadosChat.mensagensHoje >= LIMITE_DIARIO)
    return { text: '⛔ Limite diário atingido. Retorne amanhã! 🏐', confetti: false, telemetryFailure: true };

  var infoAgendamento    = obterAgendamentoAtivo(userData.whatsapp);
  var fase               = (dadosChat.fase === FASE.CONCLUIDO) ? FASE.CONCLUIDO : FASE.INICIO;
  var isAgendamentoAtivo = infoAgendamento && (infoAgendamento.status === 'CONFIRMED' || infoAgendamento.status === 'PENDING');
  var systemInstruction  = montarPromptMestre(userData, hoje, isAgendamentoAtivo ? infoAgendamento : null);
  var historyParaGemini  = history.length > MAX_HISTORY_MSGS ? history.slice(history.length - MAX_HISTORY_MSGS) : history;

  var payload = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: historyParaGemini.map(function(m) { return { role: m.role, parts: m.parts }; }),
    generationConfig: { temperature: 0.1, maxOutputTokens: 1500 }
  };

  try {
    var json = chamarGemini(payload);
    var candidate = json.candidates[0];

    if (candidate.finishReason === 'MAX_TOKENS') {
      Logger.log('[AVISO] Resposta truncada por MAX_TOKENS. Considere aumentar maxOutputTokens ou reduzir o prompt.');
      return { text: 'Minha resposta ficou muito longa! Pode reformular sua pergunta de forma mais direta? 🏐', confetti: false, telemetryFailure: true };
    }

    var botText     = candidate.content.parts[0].text;
    var tagProcessada = false;

    // --- [BOOKING] ---
    var bookingMatch = botText.match(/\[BOOKING\]([\s\S]*?)\[\/BOOKING\]/);
    if (bookingMatch && !isAgendamentoAtivo) {
      tagProcessada = true;
      try {
        var bData = JSON.parse(bookingMatch[1].replace(/`{3}json|`{3}/g, '').trim());
        bData.data = sanitizarDataParaISO(bData.data);
        var infoExata = normalizarDadosAgendamento(bData.equipe);
        if (infoExata) { bData.equipe = infoExata.equipe; bData.local = infoExata.local; }
        var validacao = validarNomeMenor(bData.equipe, bData.nome_menor);
        if (!validacao.valido) {
          botText = 'Falta só um detalhe! Para a ' + (bData.equipe || 'turma') + ', preciso do **nome completo (nome e sobrenome)** do aluno(a). Pode me informar? 📝';
          fase = FASE.INICIO;
          tagProcessada = false;
        } else {
          if (registrarAgendamento(userData.whatsapp, userData.name, bData)) {
            enviarEmailAgendamento(bData, userData.name, userData.whatsapp);
            fase = FASE.CONCLUIDO;
          } else {
            botText = botText.replace(/\[BOOKING\][\s\S]*?\[\/BOOKING\]/g, '').trim();
            botText += '\n\n⚠️ Houve um problema técnico ao registrar sua vaga. Por favor, tente confirmar novamente. Se o erro persistir, acesse nosso [WhatsApp](https://wa.me/5541999147597) para concluir manualmente.';
            fase = FASE.CONFIRMACAO;
          }
        }
      } catch (e) {
        Logger.log('[ERRO processar BOOKING] ' + e);
        botText = 'Não consegui processar os dados do agendamento. Pode repetir sua confirmação? 🏐';
        fase = FASE.CONFIRMACAO;
      }
      botText = botText.replace(/\[BOOKING\][\s\S]*?\[\/BOOKING\]/g, '').trim();
    }

    // --- [REAGENDAR] ---
    var updateMatch = botText.match(/\[REAGENDAR\]([\s\S]*?)\[\/REAGENDAR\]/);
    if (updateMatch && isAgendamentoAtivo) {
      try {
        var rData = JSON.parse(updateMatch[1].replace(/`{3}json|`{3}/g, '').trim());
        rData.data = sanitizarDataParaISO(rData.data);
        var infoExataR = normalizarDadosAgendamento(rData.equipe);
        if (infoExataR) { rData.equipe = infoExataR.equipe; rData.local = infoExataR.local; }
        if (atualizarAgendamentoExistente(rData, infoAgendamento.reschedule_count, hoje)) {
          fase = FASE.CONCLUIDO; tagProcessada = true;
        }
      } catch (e) { Logger.log('[ERRO processar REAGENDAR] ' + e); }
      botText = botText.replace(/\[REAGENDAR\][\s\S]*?\[\/REAGENDAR\]/g, '').trim();
    }

    // --- Backup de recuperação ---
    if (!tagProcessada && /confirmado|registrado|concluído/i.test(botText) && /agendamento|reagendamento/i.test(botText)) {
      try {
        var backupResult = recuperarAgendamentoDoHistorico(
          userData.whatsapp, userData.name,
          history.concat([{ role: 'model', parts: [{ text: botText }] }])
        );
        if (backupResult.status === 'recuperado') {
          tagProcessada = true; fase = FASE.CONCLUIDO;
        } else {
          botText = "Quase lá! Para eu oficializar a vaga no sistema, você **confirma** esse agendamento?";
          fase = FASE.CONFIRMACAO;
        }
      } catch (err) {
        Logger.log('[ERRO backup recuperação] ' + err);
        botText = "Tudo certo com os dados! Para oficializar no sistema de vagas, você **confirma** o agendamento?";
        fase = FASE.CONFIRMACAO;
      }
    }

    if (!tagProcessada && !isAgendamentoAtivo && fase !== FASE.CONCLUIDO) fase = FASE.INICIO;

    var botTime = new Date().toISOString();
    salvarHistoricoSupabase(
      userData.whatsapp, userData.name,
      history.concat([{ role: 'model', parts: [{ text: botText }], timestamp: botTime }]),
      dadosChat.mensagensHoje + 1, hoje, fase
    );

    return { text: botText, confetti: (fase === FASE.CONCLUIDO && tagProcessada) };

  } catch (e) {
    Logger.log('[ERRO FATAL processChatMessage] ' + e);
    return { text: 'Poxa, nossa rede oscilou. Pode tentar enviar sua última mensagem novamente? 🏐', confetti: false, telemetryFailure: true };
  }
}

// =======================================================================
// PROMPT MESTRE
// =======================================================================
function montarPromptMestre(userData, hoje, infoAgendamento) {
  var quadro = obterQuadroDoSupabase();

  if (infoAgendamento) {
    return 'Você é o Assistente da Apollo. O usuário JÁ POSSUI um agendamento ativo em "' + infoAgendamento.target_team + '" para "' + infoAgendamento.scheduled_at + '".\n' +
      'Se ele pedir para REAGENDAR:\n' +
      '1. Mostre as datas futuras disponíveis do QUADRO abaixo.\n' +
      '2. Após ele escolher, resuma e pergunte: "Confirma a mudança de data?"\n' +
      '3. Se confirmar, comemore e insira a tag exata no final:\n' +
      '[REAGENDAR]{"id":"' + infoAgendamento.id + '","equipe":"NOME","data":"YYYY-MM-DDTHH:mm","local":"LOCAL"}[/REAGENDAR]\n\n' +
      '✍️ FORMATAÇÃO OBRIGATÓRIA: NUNCA use asterisco solto (*) ou cerquilha (#). Use 👉 antes de cada data ou opção listada. Negrito = **texto**, itálico = _texto_, sublinhado = __texto__. Use emojis com moderação.\n\n' +
      '🏐 QUADRO OFICIAL DE EQUIPES E DATAS:\n' + quadro;
  }

  return 'Você é o Assistente Virtual da Apollo Voleibol. Você realiza os agendamentos AQUI e AGORA.\n' +
    'Usuário: ' + userData.name + ' | Data de hoje: ' + hoje + '\n\n' +
    '✍️ FORMATAÇÃO OBRIGATÓRIA DAS RESPOSTAS:\n' +
    '- NUNCA use asterisco solto (*) para bullet point nem cerquilha (#) para título — eles aparecem como caracteres estranhos.\n' +
    '- Para listas de equipes ou opções, use SEMPRE o emoji 👉 antes de cada item.\n' +
    '- Para NEGRITO, envolva o texto em **duplo asterisco**: **Equipe Collins**\n' +
    '- Para ITÁLICO, envolva o texto em _underline simples_: _opcional_\n' +
    '- Para SUBLINHADO, envolva o texto em __duplo underline__: __atenção__\n' +
    '- Use emojis com moderação para tornar as respostas amigáveis, mas sem exagerar.\n\n' +
    '🚨 DIRETRIZES ABSOLUTAS:\n' +
    '1. VOCÊ POSSUI A AGENDA OFICIAL. AS DATAS DO QUADRO SÃO AS ÚNCAS EXISTENTES. NUNCA diga ao usuário para ir ao WhatsApp verificar horários ou disponibilidade.\n' +
    '2. Valores de mensalidade são informados EXCLUSIVAMENTE de forma presencial. Nunca fale de preços.\n' +
    '3. Se o usuário quiser agendar para uma CRIANÇA/ADOLESCENTE, você NÃO PODE sugerir equipe sem antes saber a IDADE do menor.\n\n' +
    '📋 MÁQUINA DE PASSOS (Siga estritamente esta ordem para Novos Agendamentos):\n' +
    'PASSO 1 (IDADE): Se o usuário disser que é para filho/filha/criança, pergunte: "Qual a idade dele(a)?". Só avançe após a resposta.\n' +
    'PASSO 2 (EQUIPE): Sabendo a idade (ou se for adulto), apresente as opções de Turmas adequadas do QUADRO. Peça para o usuário escolher UMA.\n' +
    'PASSO 3 (NOME): Se a turma escolhida for para menores de idade, EXIJA O NOME E SOBRENOME do aluno antes de mostrar datas. Não aceite apelidos.\n' +
    'PASSO 4 (DATAS): Mostre as "Datas Disponíveis" apenas da equipe escolhida. Peça para escolher UMA data.\n' +
    'PASSO 5 (PERGUNTA DE CONFIRMAÇÃO): Quando ele escolher a data, resuma (Equipe, Data, Horário e Nome) e PERGUNTE EXPLICITAMENTE: "Você confirma o agendamento?". (É PROIBIDO usar as palavras "confirmado" ou "registrado" nesta etapa).\n' +
    'PASSO 6 (TAG FINAL): APENAS se o usuário respondeu "Sim" ou confirmou no Passo 5, comemore dizendo "Agendamento confirmado!" e coloque OBRIGATORIAMENTE esta tag no final da sua resposta:\n' +
    '[BOOKING]{"equipe":"NOME DA EQUIPE","data":"YYYY-MM-DDTHH:mm","local":"Local","nome_menor":"Nome Sobrenome ou null"}[/BOOKING]\n\n' +
    '🏐 QUADRO OFICIAL DE EQUIPES E DATAS:\n' + quadro;
}

// =======================================================================
// TESTE DIRETO NO EDITOR
// =======================================================================
function testeGemini() {
  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: "Olá! Responda apenas com a palavra 'Funcionou' se estiver me ouvindo." }]
    }]
  };

  try {
    var response = chamarGemini(payload);
    Logger.log('SUCESSO! O modelo respondeu:');
    Logger.log(response.candidates[0].content.parts[0].text);
  } catch (e) {
    Logger.log('FALHA NO TESTE: ' + e);
  }
}
