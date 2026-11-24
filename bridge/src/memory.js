// Память партии: переписка, заметки лидеров, сделки, мировые события.
// Хранится в data/<gameId>.json, привязка к партии — через Game:SetProperty в сейве.
import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 40;
const MAX_NOTES = 30;
const MAX_WORLD = 40;

export class Memory {
  constructor(dir, gameId) {
    this.file = path.join(dir, `${gameId.replace(/[^\w-]/g, '_')}.json`);
    fs.mkdirSync(dir, { recursive: true });
    this.data = { leaders: {}, recurring: [], pendingDeals: {}, world: [], dealSeq: 0, lastStrategyTurn: {}, lastProactiveTurn: 0 };
    if (fs.existsSync(this.file)) {
      try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) {
        console.warn('[memory] файл памяти повреждён, начинаю заново:', e.message);
      }
    }
    this._timer = null;
  }

  leader(key) {
    if (!this.data.leaders[key]) this.data.leaders[key] = { history: [], notes: [], mood: 'neutral' };
    return this.data.leaders[key];
  }

  addHistory(key, who, text, turn) {
    const l = this.leader(key);
    l.history.push({ who, text, turn });
    if (l.history.length > MAX_HISTORY) l.history.splice(0, l.history.length - MAX_HISTORY);
    this.save();
  }

  addNote(key, note, turn) {
    if (!note) return;
    const l = this.leader(key);
    l.notes.push({ note: String(note).slice(0, 300), turn });
    if (l.notes.length > MAX_NOTES) l.notes.splice(0, l.notes.length - MAX_NOTES);
    this.save();
  }

  addWorld(text, turn) {
    this.data.world.push({ text, turn });
    if (this.data.world.length > MAX_WORLD) this.data.world.splice(0, this.data.world.length - MAX_WORLD);
    this.save();
  }

  newDealId() {
    this.data.dealSeq++;
    return `D${this.data.dealSeq}`;
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this._timer);
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1), 'utf8');
  }
}
