// Regras de exibição da pesquisa de satisfação no navegador (DOM simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function page() {
  const el = () => ({ hidden: true, textContent: '', classList: { remove() {} }, querySelectorAll: () => [], appendChild() {} });
  const nodes = { chatSurvey: el(), chatSurveyStatus: el(), waModal: el(), 'chat-history': el() };
  const calls = [];
  const c = vm.createContext({
    document: { getElementById: id => nodes[id], createElement: el },
    window: { open: () => calls.push('open') },
    crypto: { randomUUID: () => 'id' },
    WA_LINK: 'https://wa.me/0',
    setTimeout: fn => fn(),
    callBackend: async (action, payload) => { calls.push(payload.kind); return {}; },
  });
  vm.runInContext(fs.readFileSync('metrics.js', 'utf8') + '\n;globalThis.flags=()=>({CHAT_RATED,CHAT_SURVEY_DISMISSED});', c);
  return { c, survey: nodes.chatSurvey, calls };
}
const session = { metrics: { id: 's', token: 't' } };
const reply = { metricsRecorded: true };

test('survey stays hidden after ordinary replies', () => {
  const { c, survey } = page();
  c.chatMetricsStart(session);
  c.chatMetricsOffer(reply);
  c.chatMetricsOffer(reply);
  assert.equal(survey.hidden, true);
});

test('survey appears after a confirmed booking (confetti)', () => {
  const { c, survey } = page();
  c.chatMetricsStart(session);
  c.chatMetricsOffer({ ...reply, confetti: true });
  assert.equal(survey.hidden, false);
});

test('survey appears after a human handoff once the assistant has replied', () => {
  const { c, survey, calls } = page();
  c.chatMetricsStart(session);
  c.chatOpenHandoff();
  assert.equal(survey.hidden, true, 'no useful reply yet: the score would be rejected by the server');
  c.chatMetricsOffer(reply);
  c.chatOpenHandoff();
  assert.equal(survey.hidden, false);
  assert.ok(calls.includes('handoff'));
});

test('closing with "x" keeps the survey hidden for the rest of the conversation', () => {
  const { c, survey } = page();
  c.chatMetricsStart(session);
  c.chatMetricsOffer({ ...reply, confetti: true });
  c.chatSurveyDismiss();
  assert.equal(survey.hidden, true);
  c.chatMetricsOffer({ ...reply, confetti: true });
  c.chatOpenHandoff();
  assert.equal(survey.hidden, true);
  c.chatMetricsStart(session); // nova conversa volta a permitir
  c.chatMetricsOffer({ ...reply, confetti: true });
  assert.equal(survey.hidden, false);
});

test('rating hides the survey and it never comes back in the same conversation', async () => {
  const { c, survey } = page();
  c.chatMetricsStart(session);
  c.chatMetricsOffer({ ...reply, confetti: true });
  await c.chatRate(5);
  assert.equal(survey.hidden, true);
  c.chatMetricsOffer({ ...reply, confetti: true });
  assert.equal(survey.hidden, true);
});

test('without a metrics session nothing is shown and WhatsApp still opens silently', () => {
  const { c, survey, calls } = page();
  c.chatMetricsStart({});
  c.chatMetricsOffer({ ...reply, confetti: true });
  c.chatOpenHandoff();
  assert.equal(survey.hidden, true);
  assert.deepEqual(calls, ['open']);
});
