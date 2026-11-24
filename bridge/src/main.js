// Точка входа моста: подключение к игре, цикл опроса, маршрутизация событий.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { TunerClient } from './tuner.js';
import { GameLink } from './game.js';
import { createLLM } from './llm.js';
import { Memory } from './memory.js';
import { Brain } from './brain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadYaml(name, required) {
  const f = path.isAbsolute(name) ? name : path.join(ROOT, name);
  if (!fs.existsSync(f)) {
    if (required) {
      console.error(`Не найден ${name}. Скопируйте config.example.yaml в config.yaml и укажите ключ API.`);
      process.exit(1);
    }
    return {};
  }
  return YAML.parse(fs.readFileSync(f, 'utf8')) || {};
}

const CONFIG = process.env.LLM_BRIDGE_CONFIG || 'config.yaml';
const DATA_DIR = process.env.LLM_BRIDGE_DATA || path.join(ROOT, 'data');
const cfg = loadYaml(CONFIG, true);
// файл характеров: можно подменить переменной LLM_BRIDGE_PERSONAS (например, для отдельной партии)
const PERSONAS = process.env.LLM_BRIDGE_PERSONAS || 'personas.yaml';
let personas = loadYaml(PERSONAS, false);
cfg.llm = cfg.llm || {};
const llm = createLLM(cfg.llm);

if (!cfg.llm.api_key && !process.env.LLM_API_KEY && !/localhost|127\.0\.0\.1/.test(cfg.llm.base_url || '')) {
  console.warn('ВНИМАНИЕ: не задан llm.api_key в config.yaml (или переменная LLM_API_KEY).');
}

// перечитывать personas.yaml на лету — характеры можно менять посреди партии
fs.watchFile(path.isAbsolute(PERSONAS) ? PERSONAS : path.join(ROOT, PERSONAS), { interval: 2000 }, () => {
  try {
    personas = loadYaml(PERSONAS, false);
    if (brain) brain.personas = personas;
    log('[personas] характеры перезагружены');
    sendNames();
  } catch (e) { log('[personas] ошибка YAML:', e.message); }
});

const tuner = new TunerClient({ host: cfg.tuner?.host || '127.0.0.1', port: cfg.tuner?.port || 4318, debug: !!cfg.tuner?.debug });
tuner.on('error', () => {});
const game = new GameLink(tuner);
let brain = null;
let memory = null;
let currentGameId = null;

async function attachGame() {
  await game.resolve();
  // перехватчики событий (ядерные удары) — ставим и в уже запущенную игру
  await game.installHooks().catch((e) => log('[hooks]', e.message));
  const gid = await game.gameId();
  if (gid !== currentGameId) {
    memory?.flush();
    currentGameId = gid;
    memory = new Memory(DATA_DIR, gid);
    brain = new Brain({ cfg, personas, llm, game, memory, log });
    log(`[game] партия ${gid} подключена (UI: ${game.uiState}${game.direct ? '' : ' через ExposedMembers'})`);
  }
  await game.deliver({
    type: 'config',
    allow_unmet: !!cfg.behavior?.allow_unmet,
    info: `${llm.provider}: ${cfg.llm.model}`,
    ui_lang: brain?.uiLang,
  });
  await sendNames();
  // вернуть в окно переписку, хронику переговоров и реестр договоров (UI не хранит их между загрузками)
  try {
    await brain.restoreChats();
    await brain.world.restore();
    await brain.powerWatch();
  } catch (e) { log('[restore]', e.message); }
}

// Свои имена лидеров (personas.yaml: name / civ) → окно чата
async function sendNames() {
  if (!brain || !game.uiState) return;
  try {
    await brain.refresh();
    await game.deliver({ type: 'config', names: brain.displayNames() });
  } catch (e) { log('[names]', e.message); }
}

async function run() {
  log(`LLM Leaders bridge — провайдер ${llm.provider}, модель ${cfg.llm.model}`);
  const pollMs = cfg.tuner?.poll_ms || 500;
  let waitingMsg = '';
  for (;;) {
    // 1. подключение к игре
    if (!tuner.connected) {
      try {
        await tuner.connect();
        log(`[tuner] подключено, Lua-состояний: ${tuner.states.size}`);
      } catch (e) {
        const m = `[tuner] нет связи с игрой (${e.message}). Запущена ли Civ 6 с EnableTuner 1? Повтор…`;
        if (m !== waitingMsg) { log(m); waitingMsg = m; }
        await sleep(3000);
        continue;
      }
    }
    // 2. привязка к партии
    if (!brain || !game.uiState) {
      try {
        await attachGame();
        waitingMsg = '';
      } catch (e) {
        const m = `[game] ожидание партии: ${e.message}`;
        if (m !== waitingMsg) { log(m); waitingMsg = m; }
        await sleep(2500);
        continue;
      }
    }
    // 3. опрос событий
    try {
      const packet = await game.poll();
      const events = packet?.events || [];
      if (events.some((ev) => ev.type === 'ui_loaded')) {
        // загружена другая партия или сейв — переподключиться
        game.uiState = null;
      } else if (events.length) {
        for (const ev of events) {
          if (ev.type === 'turn_begin') {
            const s = llm.stats;
            log(`[turn ${ev.turn}] LLM: вызовов ${s.calls}, токенов ${s.inputTokens}→${s.outputTokens}, ошибок ${s.errors}`);
          }
        }
        await brain.onEvents(events).catch((e) => log('[brain]', e.message));
      }
    } catch (e) {
      log(`[poll] ${e.message} — переподключение`);
      game.uiState = null;
      if (!tuner.connected || /соединени/.test(e.message)) tuner.close();
      await sleep(1500);
      continue;
    }
    await sleep(pollMs);
  }
}

process.on('SIGINT', () => { memory?.flush(); process.exit(0); });
run();
