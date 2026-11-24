// Фаза 0: проверка связи с игрой и доступности нужных функций.
// Запуск: загрузите партию в Civ 6 (с включённым модом и EnableTuner 1), затем `node probe.js`.
// Результат пишется в probe-report.txt.
import fs from 'node:fs';
import { TunerClient } from './src/tuner.js';
import { GameLink } from './src/game.js';
import { findResults, findError, toLua } from './src/lua.js';

const report = [];
const out = (...a) => { const s = a.join(' '); console.log(s); report.push(s); };
const ok = (name, cond, extra = '') => out(`${cond ? '[OK]  ' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);

const tuner = new TunerClient({ debug: process.argv.includes('--debug') });
tuner.on('error', () => {});

async function main() {
  out(`Проверка LLM Leaders — ${new Date().toLocaleString()}`);
  try {
    await tuner.connect();
  } catch (e) {
    ok('Подключение к FireTuner (127.0.0.1:4318)', false, e.message);
    out('  → Включите «Tuner» в настройках игры или EnableTuner 1 в AppOptions.txt, перезапустите игру и загрузите партию.');
    return;
  }
  ok('Подключение к FireTuner', true, `Lua-состояний: ${tuner.states.size}`);
  out('Состояния: ' + [...tuner.states.entries()].map(([n, i]) => `${i}:${n}`).join(', '));

  const gc = tuner.findState('GameCore_Tuner');
  ok('Состояние GameCore_Tuner', !!gc, gc ? '' : 'партия не загружена?');
  if (!gc) return;

  // 1. простой print
  const hello = await tuner.exec(gc, 'print("LLMR|hello")');
  ok('Выполнение Lua и получение print()', findResults(hello)[0] === 'hello', JSON.stringify(hello));

  // 2. кириллица туда и обратно
  const ru = 'Проверка связи: Ёё, Пётр Великий!';
  const ruLines = await tuner.exec(gc, `print("LLMR|" .. ${toLua(ru)})`);
  const ruBack = findResults(ruLines)[0];
  ok('Кириллица мост → игра → мост', ruBack === ru, `получено: ${ruBack}`);

  // 3. наличие функций в игровом контексте
  const checks = {
    'Diplomacy:DeclareWarOn': 'Players[0]:GetDiplomacy().DeclareWarOn',
    'Diplomacy:MakePeaceWith': 'Players[0]:GetDiplomacy().MakePeaceWith',
    'Diplomacy:ChangeFavor': 'Players[0]:GetDiplomacy().ChangeFavor',
    'Diplomacy:IsAtWarWith': 'Players[0]:GetDiplomacy().IsAtWarWith',
    'Treasury:ChangeGoldBalance': 'Players[0]:GetTreasury().ChangeGoldBalance',
    'Resources:ChangeResourceAmount': 'Players[0]:GetResources().ChangeResourceAmount',
    'Ai_Diplomacy:AdjustBaseDiplomacy': 'Players[0]:GetAi_Diplomacy().AdjustBaseDiplomacy',
    'Game:SetProperty': 'Game.SetProperty',
    'WarTypes.FORMAL_WAR': 'WarTypes.FORMAL_WAR',
  };
  for (const [name, expr] of Object.entries(checks)) {
    const l = await tuner.exec(gc, `print("LLMR|" .. type(${expr}))`);
    const t = findResults(l)[0];
    ok(name, t === 'function' || t === 'number', t || findError(l) || 'нет ответа');
  }

  // 4. мод
  const link = new GameLink(tuner);
  try {
    await link.resolve();
    ok('Мод LLM Leaders загружен', true, `контекст: ${link.uiState}${link.direct ? '' : ' (через ExposedMembers)'}`);
  } catch (e) {
    ok('Мод LLM Leaders загружен', false, e.message);
    return;
  }

  const gid = await link.gameId();
  ok('ID партии в сейве', !!gid, gid);

  const poll = await link.poll();
  ok('LLM_Poll', !!poll, poll ? `событий: ${poll.events?.length ?? 0}, ход ${poll.turn}` : '');

  const snap = await link.snapshot();
  ok('LLM_Snapshot', snap.players.length > 0, `игроков: ${snap.players.length}, ход ${snap.turn}, эпоха ${snap.era}`);
  for (const p of snap.players) {
    out(`   ${p.id}: ${p.leader} (${p.civ}) ${p.human ? '[ВЫ]' : ''} золото ${p.gold} (${p.goldPerTurn}/ход), благоскл. ${p.favor}, ` +
      `сила ${p.military}, стратег.: ${JSON.stringify(p.strategic)}, отношений: ${Object.keys(p.relations).length}`);
  }

  // 5. доставка сообщения в окно
  const ai = snap.players.find((p) => !p.human);
  if (ai) {
    await link.deliver({ type: 'config', allow_unmet: true, info: 'probe' });
    await link.deliver({ type: 'chat', leader: ai.id, text: `${ru} Это тестовое сообщение от моста. Если вы читаете его без «кракозябр» — всё работает.` });
    ok('Сообщение доставлено в окно чата', true, `откройте «ИИ-дипломатия» → ${ai.leader} (тест включил показ невстреченных лидеров)`);
  }
  out('\nГотово. Если все пункты [OK] — можно запускать мост: start.bat');
}

main()
  .catch((e) => out('[FAIL] Неожиданная ошибка: ' + e.stack))
  .finally(() => {
    fs.writeFileSync(new URL('./probe-report.txt', import.meta.url), report.join('\n'), 'utf8');
    tuner.close();
    setTimeout(() => process.exit(0), 200);
  });
