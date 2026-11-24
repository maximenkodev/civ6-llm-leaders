// Клиент протокола FireTuner (TCP 4318).
// Кадр: <u32 LE длина payload><u32 LE тег><payload UTF-8 + \0>
//   тег 4  — служебные (APP:, LSQ:)
//   тег 3  — команда CMD:<индекс состояния>:<lua>
//   тег 0xFFFFFFFF — вывод print() из игры
import net from 'node:net';
import { EventEmitter } from 'node:events';

const TAG_CMD = 3;
const TAG_APP = 4;
const TAG_OUT = 0xffffffff;

export class TunerClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 4318, debug = false } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.debug = debug;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.states = new Map(); // name -> index
    this.connected = false;
    this._statesWaiter = null;
    this._current = null; // выполняющаяся команда
    this._queue = Promise.resolve();
    this._seq = 0;
  }

  async connect(timeoutMs = 6000) {
    this.close();
    this.buf = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { sock.destroy(); reject(new Error('timeout подключения')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(); });
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
      this.sock = sock;
    });
    this.sock.setNoDelay(true);
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('close', () => {
      this.connected = false;
      if (this._current) { this._current.reject(new Error('соединение закрыто')); this._current = null; }
      this.emit('close');
    });
    this.connected = true;
    this._send(TAG_APP, 'APP:');
    await this.refreshStates(timeoutMs);
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = null;
    this.connected = false;
  }

  refreshStates(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._statesWaiter = null; reject(new Error('игра не прислала список Lua-состояний (загружена ли партия?)')); }, timeoutMs);
      this._statesWaiter = (states) => { clearTimeout(t); resolve(states); };
      this._send(TAG_APP, 'LSQ:');
    });
  }

  findState(...candidates) {
    for (const c of candidates) if (this.states.has(c)) return c;
    const names = [...this.states.keys()];
    for (const c of candidates) {
      const hit = names.find((n) => n.toLowerCase().includes(c.toLowerCase()));
      if (hit) return hit;
    }
    return null;
  }

  // Выполнить Lua в состоянии stateName. Возвращает массив строк вывода.
  exec(stateName, code, { timeoutMs = 8000 } = {}) {
    const run = () => this._execNow(stateName, code, timeoutMs);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  _execNow(stateName, code, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('нет соединения с игрой'));
      const idx = this.states.get(stateName);
      if (idx === undefined) return reject(new Error(`Lua-состояние не найдено: ${stateName}`));
      const sentinel = `<<<LLMB_END_${++this._seq}>>>`;
      const wrapped =
        `local __ok, __err = pcall(function()\n${code}\nend)\n` +
        `if not __ok then print("LLMERR|" .. tostring(__err)) end\n` +
        `print("${sentinel}")`;
      const lines = [];
      const t = setTimeout(() => {
        this._current = null;
        reject(new Error(`timeout выполнения в ${stateName}`));
      }, timeoutMs);
      this._current = {
        sentinel,
        lines,
        resolve: (l) => { clearTimeout(t); resolve(l); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      this._send(TAG_CMD, `CMD:${idx}:${wrapped}`);
    });
  }

  _send(tag, str) {
    if (!this.sock) return;
    const payload = Buffer.from(str + '\0', 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt32LE(tag >>> 0, 4);
    if (this.debug) console.log(`[tuner >] tag=${tag} ${str.slice(0, 200).replace(/\n/g, '⏎')}`);
    this.sock.write(Buffer.concat([header, payload]));
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32LE(0);
      const tag = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      this._onFrame(tag, payload);
    }
  }

  _onFrame(tag, payload) {
    const parts = payload.toString('utf8').split('\0');
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    if (this.debug) console.log(`[tuner <] tag=${tag} ${JSON.stringify(parts).slice(0, 300)}`);

    if (tag === TAG_OUT) {
      // Варианты формата: ["O", "Context: text"] или ["text"]
      const text = parts.length >= 2 && parts[0].length <= 2 ? parts.slice(1).join('') : parts.join('');
      this.emit('output', text);
      const cur = this._current;
      if (cur) {
        if (text.includes(cur.sentinel)) {
          this._current = null;
          cur.resolve(cur.lines);
        } else {
          cur.lines.push(text);
        }
      }
      return;
    }

    const first = parts[0] ?? '';
    if (first.startsWith('ERR')) {
      const cur = this._current;
      if (cur) { this._current = null; cur.reject(new Error(`ошибка тюнера: ${parts.join(' ')}`)); }
      return;
    }

    // Список состояний: "<idx>\0<name>\0<idx>\0<name>..."
    if (this._statesWaiter && /^\d+$/.test(first) && parts.length >= 2) {
      this.states.clear();
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const idx = Number(parts[i]);
        if (Number.isFinite(idx)) this.states.set(parts[i + 1], idx);
      }
      const w = this._statesWaiter;
      this._statesWaiter = null;
      w(this.states);
      return;
    }
    this.emit('frame', tag, parts);
  }
}
