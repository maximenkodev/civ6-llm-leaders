// JS-значение -> литерал Lua. Все не-ASCII байты экранируются как \ddd,
// чтобы кириллица гарантированно дошла до игры без искажений.
export function toLua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'string') return luaString(v);
  if (Array.isArray(v)) return '{' + v.map(toLua).join(',') + '}';
  if (typeof v === 'object') {
    return '{' + Object.entries(v)
      .filter(([, val]) => val !== undefined)
      .map(([k, val]) => `[${luaString(k)}]=${toLua(val)}`)
      .join(',') + '}';
  }
  return 'nil';
}

export function luaString(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '"';
  for (const b of bytes) {
    if (b >= 32 && b < 127 && b !== 34 && b !== 92) out += String.fromCharCode(b);
    else out += '\\' + String(b).padStart(3, '0');
  }
  return out + '"';
}

// Сборка пакетов "LLMQ|seq|i|n|hex" из строк вывода.
export function parsePackets(lines) {
  const chunks = new Map(); // seq -> {n, parts[]}
  const packets = [];
  for (const raw of lines) {
    const at = raw.indexOf('LLMQ|');
    if (at < 0) continue;
    const [, seq, i, n, hex] = raw.slice(at).trim().split('|');
    if (!hex) continue;
    const entry = chunks.get(seq) ?? { n: Number(n), parts: [] };
    entry.parts[Number(i) - 1] = hex;
    chunks.set(seq, entry);
    if (entry.parts.filter(Boolean).length === entry.n) {
      chunks.delete(seq);
      try {
        const json = Buffer.from(entry.parts.join(''), 'hex').toString('utf8');
        packets.push(JSON.parse(json));
      } catch (e) {
        console.warn('[lua] не удалось разобрать пакет:', e.message);
      }
    }
  }
  return packets;
}

export function findError(lines) {
  for (const l of lines) {
    const at = l.indexOf('LLMERR|');
    if (at >= 0) return l.slice(at + 7);
  }
  return null;
}

export function findResults(lines) {
  const out = [];
  for (const l of lines) {
    const at = l.indexOf('LLMR|');
    if (at >= 0) out.push(l.slice(at + 5).trim());
  }
  return out;
}
