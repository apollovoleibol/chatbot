# chatbot
Chatbot de atendimento ao público

`index.html` e `metrics.js` compõem o frontend publicado no GitHub Pages. O backend do projeto Apps Script está versionado em `apps-script/Code.gs` e `apps-script/Metrics.gs`; atualizar esses arquivos no GitHub não atualiza automaticamente a implantação do Apps Script.

As propriedades existentes `SUPABASE_URL`, `SUPABASE_KEY`, a opcional `SUPABASE_SERVICE_KEY` (chave de servidor usada apenas pela coleta de métricas), `GEMINI_API_KEY` e `FRONTEND_SECRET` permanecem no Apps Script. O segredo presente no frontend é público e não deve ser considerado autenticação de usuário.

Veja [coleta de indicadores e implantação](docs/atendimento-metricas.md). Os testes locais podem ser executados com `node --test metrics.test.cjs`.
