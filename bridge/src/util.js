// Общие помощники моста.
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const toInt = (v) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : 0; };

// Нормализация предметов сделки из ответа LLM
export function normItems(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && typeof i === 'object').map((i) => {
    const type = String(i.type || '').toLowerCase().trim();
    const out = { type };
    if (type !== 'peace') out.amount = Math.max(0, toInt(i.amount));
    if (type === 'gold_per_turn') out.turns = clamp(toInt(i.turns) || 10, 1, 60);
    if (type === 'resource') {
      let r = String(i.resource || '').toUpperCase().trim();
      if (r && !r.startsWith('RESOURCE_')) r = 'RESOURCE_' + r;
      out.resource = r;
    }
    if (type === 'wmd') {
      out.wmd = /thermo|термо/i.test(String(i.wmd || i.kind || '')) ? 'thermonuclear' : 'nuclear';
      out.amount = clamp(out.amount || 1, 1, 5);
    }
    if (type === 'unit') {
      let u = String(i.unit || '').toUpperCase().trim();
      if (u && !u.startsWith('UNIT_')) u = 'UNIT_' + u;
      out.unit = u;
      out.amount = clamp(out.amount || 1, 1, 5);
    }
    return out;
  });
}
