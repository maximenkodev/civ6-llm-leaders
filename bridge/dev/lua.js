// Отладка: выполнить Lua в указанном состоянии игры через FireTuner.
// node dev/lua.js <State> "<lua code>"   (мост при этом должен быть остановлен)
import { TunerClient } from '../src/tuner.js';
const [state, code] = process.argv.slice(2);
const t = new TunerClient({ host: '127.0.0.1', port: 4318 });
t.on('error', () => {});
await t.connect();
const name = t.findState(state);
if (!name) { console.error('нет состояния', state); process.exit(1); }
const lines = await t.exec(name, code, { timeoutMs: 8000 });
for (const l of lines) console.log(l);
t.close();
process.exit(0);
