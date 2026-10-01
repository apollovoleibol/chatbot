# Coleta de atendimento — Huddle v2.8

O Apps Script é a autoridade de gravação. O navegador nunca envia horários nem pode chamar as funções de ingestão diretamente no Supabase. As funções de coleta só aceitam a chave de servidor (service_role). O módulo usa a propriedade `SUPABASE_SERVICE_KEY`, se existir, e cai para `SUPABASE_KEY` caso contrário. Se `SUPABASE_KEY` for a chave pública (anon), cadastre a chave de servidor em `SUPABASE_SERVICE_KEY` nas Propriedades do script. Nunca publicar essa chave no repositório nem no frontend.

O cadastro de agendamentos não depende da coleta: o id do agendamento só é solicitado quando há sessão de métricas e, se a chave não puder ler a linha criada, o Apps Script repete o envio com `return=minimal` (o PostgreSQL desfaz o primeiro INSERT por inteiro).

- Primeira resposta: média do intervalo entre a primeira mensagem recebida pelo servidor e a primeira resposta útil preparada pelo assistente. Não inclui a saudação local nem o tempo de download no aparelho. Falhas e limites não contam como resposta útil.
- Tempo até agendar: primeira mensagem até a gravação confirmada de um novo agendamento nesta sessão; exclui sessões com agendamento anterior, reagendamentos e quem não agendou.
- Retorno humano: pedido explícito pelo botão de WhatsApp até a primeira resposta que o atendente declara no Huddle. Abrir WhatsApp não comprova envio; esta medição é manual e precisa ser registrada no momento da resposta.
- Satisfação: pesquisa opcional de 1 a 5 sobre o assistente, uma resposta por sessão. CSAT = notas 4 e 5 / total de avaliações. A pesquisa aparece no chat; não há disparo automático de mensagem externa.

Coorte móvel de 30 dias por início do atendimento, com tamanho de amostra e solicitações sem retorno. Sessões válidas por 24 horas. Histórico anterior não é reconstruído. A telemetria não duplica o texto das mensagens. Contatos da fila vêm de quem iniciou a conversa (responsável quando o atendimento se refere a menor); o formulário já solicita os dados desse contato.

Aplicar a migração 022 no projeto Supabase da Apollo, salvar Code.gs e Metrics.gs no projeto Apps Script existente e atualizar a implantação existente com uma nova versão. Publicar o frontend somente após testar a coleta. A função diagnosticarMetricasAtendimento cria dados marcados como teste, não manda mensagens, não usa Gemini e não cria agendamento. Reexecutá-la consome uma sessão de teste e não altera métricas reais.

As funções de coleta são exclusivas de service_role. Usuários autenticados recebem apenas os agregados ou a fila permitida por seu perfil; anônimos não leem a telemetria. A fila permite que Administrador, Atendimento e Coordenação com permissão em Agendamentos registrem respostas. Técnicos e atletas não recebem essa fila global.

Se a coleta falhar, o chat continua respondendo e o Apps Script registra METRICS_ERROR sem telefone, token ou conteúdo. Verificar esses registros em Execuções; não interpretar ausência de amostras como zero segundos.


## Implantação em produção

30/09/2026: migração 022 aplicada; `Code.gs` e `Metrics.gs` desta branch salvos no projeto Apps Script e publicados na implantação existente como versão 121 (mesma URL do Web App). `SUPABASE_KEY` já é service_role, então `SUPABASE_SERVICE_KEY` não foi necessária. Diagnóstico: `HUDDLE_METRICS_OK`. Pendente: publicar `index.html` + `metrics.js` (merge em `main`).
