// Связь с конкретной партией: опрос мода, снимки состояния, игровые действия.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLua, luaString, parsePackets, findError, findResults } from './lua.js';

const MOD_LUA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mod/LLMLeaders/UI/LLMLeaders.lua');

export class GameLink {
  constructor(tuner) {
    this.tuner = tuner;
    this.uiState = null;     // наш UI-контекст или InGame
    this.direct = false;     // true — функции мода доступны как глобальные
    this.gameState = null;   // GameCore_Tuner
  }

  // Найти нужные Lua-состояния. Бросает ошибку, если партия не загружена или мод не активен.
  async resolve() {
    await this.tuner.refreshStates();
    this.gameState = this.tuner.findState('GameCore_Tuner');
    const own = this.tuner.findState('LLMLeaders');
    if (own) {
      this.uiState = own;
      this.direct = true;
    } else {
      this.uiState = this.tuner.findState('InGame');
      this.direct = false;
    }
    if (!this.gameState || !this.uiState) {
      throw new Error('партия не загружена (нет GameCore_Tuner/InGame)');
    }
    // Проверить, что мод действительно загружен
    const lines = await this.tuner.exec(this.uiState,
      this.direct
        ? 'print("LLMR|" .. tostring(LLM_Poll ~= nil))'
        : 'print("LLMR|" .. tostring(ExposedMembers.LLMLeaders ~= nil))');
    if (findResults(lines)[0] !== 'true') {
      throw new Error('мод LLM Leaders не активен в этой партии (включите его в «Дополнения» перед стартом)');
    }
  }

  _ui(fn, argLua = '') {
    return this.direct ? `LLM_${fn}(${argLua})` : `ExposedMembers.LLMLeaders.${fn}(${argLua})`;
  }

  async poll() {
    // + события из глобального LLM_ExtraEvents (ядерные удары и др.), если есть
    const extra = this.direct
      ? '; if LLM_ExtraEvents ~= nil and #LLM_ExtraEvents > 0 and LLMJson ~= nil then ' +
        'LLMJson.PrintPacket({ kind = "extra", events = LLM_ExtraEvents }); LLM_ExtraEvents = {} end'
      : '';
    const lines = await this.tuner.exec(this.uiState, this._ui('Poll') + extra);
    const err = findError(lines);
    if (err) throw new Error('LLM_Poll: ' + err);
    const packets = parsePackets(lines);
    const poll = packets.find((p) => p.kind === 'poll') ?? null;
    for (const p of packets) {
      if (p.kind === 'extra' && Array.isArray(p.events)) {
        if (poll) (poll.events = Array.isArray(poll.events) ? poll.events : []).push(...p.events);
      }
    }
    return poll;
  }

  // Поставить перехватчики событий в уже запущенную игру (код берём из файла мода,
  // чтобы не требовать перезагрузки сохранения после обновления мода)
  async installHooks() {
    if (!this.direct) return;
    const src = fs.readFileSync(MOD_LUA, 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('function LLM_InstallWMDHook()');
    const end = src.indexOf('\nend\n', start);
    if (start < 0 || end < 0) return;
    const fn = src.slice(start, end + 4);
    const lines = await this.tuner.exec(this.uiState,
      `if LLM_InstallWMDHook == nil then\n${fn}\nend\nLLM_InstallWMDHook(); print("LLMR|" .. tostring(LLM_WMDHooked))`);
    const err = findError(lines);
    if (err) throw new Error('installHooks: ' + err);
    return findResults(lines)[0];
  }

  async snapshot() {
    const lines = await this.tuner.exec(this.uiState, this._ui('Snapshot'), { timeoutMs: 15000 });
    const err = findError(lines);
    if (err) throw new Error('LLM_Snapshot: ' + err);
    const snap = parsePackets(lines).find((p) => p.kind === 'snapshot');
    if (!snap) throw new Error('пустой снимок состояния');
    return normalizeSnapshot(snap);
  }

  async deliver(msg) {
    const lines = await this.tuner.exec(this.uiState, this._ui('Deliver', toLua(msg)));
    const err = findError(lines);
    if (err) throw new Error('LLM_Deliver: ' + err);
  }

  // Доставить список элементов порциями: одна команда тюнера — не больше maxChars Lua-кода
  // (кириллица экранируется \ddd и раздувает текст в ~8 раз, а игру нельзя заваливать командами).
  async deliverChunked(base, field, list, maxChars = 7000) {
    let chunk = [];
    let size = 0;
    for (const it of list) {
      const n = toLua(it).length;
      if (chunk.length && size + n > maxChars) {
        await this.deliver({ ...base, [field]: chunk });
        chunk = []; size = 0;
      }
      chunk.push(it); size += n;
    }
    if (chunk.length) await this.deliver({ ...base, [field]: chunk });
  }

  // Нативная сделка игры между игроком-человеком (me) и ИИ (other), выполняется в UI-контексте.
  // Отправка сразу с DealProposalAction.ACCEPTED исполняет её немедленно, минуя оценку стандартного ИИ
  // (решение уже принял LLM-лидер). Проверено в живой игре на открытых границах.
  // items: [{ type: 'open_borders', from }, { type: 'resource', from, resource, amount }]  — на 30 ходов
  // dry = true — только собрать и проверить сделку, не отправляя.
  async nativeDeal(me, other, items, { dry = false } = {}) {
    const add = items.map((i) => {
      if (i.type === 'open_borders') {
        return `do local it = deal:AddItemOfType(DealItemTypes.AGREEMENTS, ${int(i.from)}); if it == nil then error("не удалось добавить право прохода") end\n` +
          `it:SetSubType(DealAgreementTypes.OPEN_BORDERS); it:SetDuration(30) end`;
      }
      if (i.type === 'resource') {
        return `do local r = GameInfo.Resources[${luaString(i.resource)}]; if r == nil then error("нет ресурса") end\n` +
          `local it = deal:AddItemOfType(DealItemTypes.RESOURCES, ${int(i.from)}); if it == nil then error("не удалось добавить ресурс") end\n` +
          `it:SetValueType(r.Index); it:SetAmount(${int(i.amount || 1)}); it:SetDuration(30) end`;
      }
      throw new Error('неизвестный нативный предмет ' + i.type);
    }).join('\n');
    const code = `local me, other = ${int(me)}, ${int(other)}
DealManager.ClearWorkingDeal(DealDirection.OUTGOING, me, other)
local deal = DealManager.GetWorkingDeal(DealDirection.OUTGOING, me, other)
if deal == nil then error("игра не дала создать сделку") end
${add}
if not deal:IsValid() then DealManager.ClearWorkingDeal(DealDirection.OUTGOING, me, other); error("игра считает сделку недопустимой") end
${dry ? 'DealManager.ClearWorkingDeal(DealDirection.OUTGOING, me, other); print("LLMR|valid")'
      : 'DealManager.SendWorkingDeal(DealProposalAction.ACCEPTED, me, other); print("LLMR|ok")'}`;
    const lines = await this.tuner.exec(this.uiState, code);
    const err = findError(lines);
    if (err) throw new Error(err.split('\n')[0].replace(/^.*?:\d+: /, ''));
    return findResults(lines);
  }

  // Есть ли у игрока a право прохода через земли b (UI-контекст)
  async hasOpenBorders(a, b) {
    const lines = await this.tuner.exec(this.uiState,
      `print("LLMR|" .. tostring(Players[${int(a)}]:GetDiplomacy():HasOpenBordersFrom(${int(b)})))`);
    return findResults(lines)[0] === 'true';
  }

  // ---- Игровые действия (GameCore_Tuner) ----
  async gameplay(code) {
    const lines = await this.tuner.exec(this.gameState, code);
    const err = findError(lines);
    if (err) throw new Error(err.split('\n')[0].replace(/^\[string[^\]]*\]:\d+: /, ''));
    return findResults(lines);
  }

  async gameId() {
    const fresh = 'G' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const r = await this.gameplay(
      `local id = Game:GetProperty("LLM_GAME_ID")\n` +
      `if id == nil then id = ${luaString(fresh)}; Game:SetProperty("LLM_GAME_ID", id) end\n` +
      `print("LLMR|" .. tostring(id))`);
    return r[0] ?? fresh;
  }

  changeGold(pid, amount) {
    // возвращает "было->стало" для проверки
    return this.gameplay(`local t = Players[${int(pid)}]:GetTreasury(); local b = t:GetGoldBalance(); ` +
      `t:ChangeGoldBalance(${int(amount)}); print("LLMR|" .. math.floor(b) .. "->" .. math.floor(t:GetGoldBalance()))`);
  }

  changeFavor(pid, amount) {
    return this.gameplay(`local d = Players[${int(pid)}]:GetDiplomacy(); local b = d:GetFavor(); ` +
      `d:ChangeFavor(${int(amount)}); print("LLMR|" .. b .. "->" .. d:GetFavor())`);
  }

  changeResource(pid, resourceType, amount) {
    return this.gameplay(
      `local r = GameInfo.Resources[${luaString(resourceType)}]\n` +
      `if r == nil then error("нет ресурса ${resourceType.replace(/[^A-Z_]/g, '')}") end\n` +
      `local pr = Players[${int(pid)}]:GetResources(); local b = pr:GetResourceAmount(r.Index)
` +
      `pr:ChangeResourceAmount(r.Index, ${int(amount)}); print("LLMR|" .. b .. "->" .. pr:GetResourceAmount(r.Index))`);
  }

  // Ядерный арсенал и ударные силы всех держав:
  // { pid: { nuclear, thermo, carriers, bombers, fighters, subs, capital } }
  // (GameInfo.WMDs: 0 — ядерный, 1 — термоядерный; проверено в живой игре)
  async power() {
    const r = await this.gameplay(`
local cls = {}
local function add(t, k) local row = GameInfo.Units[t]; if row then cls[row.Index] = k end end
add("UNIT_AIRCRAFT_CARRIER", "c"); add("UNIT_BOMBER", "b"); add("UNIT_JET_BOMBER", "b")
add("UNIT_FIGHTER", "f"); add("UNIT_JET_FIGHTER", "f"); add("UNIT_NUCLEAR_SUBMARINE", "s")
add("UNIT_BATTLESHIP", "w"); add("UNIT_MISSILE_CRUISER", "w"); add("UNIT_DESTROYER", "w"); add("UNIT_GIANT_DEATH_ROBOT", "g")
local out = {}
for _, p in ipairs(PlayerManager.GetAliveMajors()) do
  local w = p:GetWMDs()
  local n = { c = 0, b = 0, f = 0, s = 0, w = 0, g = 0 }
  for _, u in p:GetUnits():Members() do local k = cls[u:GetType()]; if k then n[k] = n[k] + 1 end end
  out[#out+1] = table.concat({ p:GetID(), w:GetWeaponCount(0), w:GetWeaponCount(1), n.c, n.b, n.f, n.s, n.w, n.g }, ":")
end
print("LLMR|" .. table.concat(out, ";"))`);
    const out = {};
    for (const part of String(r[0] || '').split(';')) {
      const [id, nuclear, thermo, carriers, bombers, fighters, subs, warships, robots] = part.split(':').map(Number);
      if (Number.isFinite(id)) out[id] = { nuclear, thermo, carriers, bombers, fighters, subs, warships, robots };
    }
    return out;
  }

  // Ядерные заряды: idx 0 — ядерный, 1 — термоядерный. Возвращает «было->стало».
  changeWMD(pid, idx, amount) {
    return this.gameplay(`local w = Players[${int(pid)}]:GetWMDs(); local b = w:GetWeaponCount(${int(idx)}); ` +
      `w:ChangeWeaponCount(${int(idx)}, ${int(amount)}); print("LLMR|" .. b .. "->" .. w:GetWeaponCount(${int(idx)}))`);
  }

  // Боевые юниты всех держав: { pid: { UNIT_X: { name, count } } } (без мирных: строителей, поселенцев, великих людей…)
  async units() {
    const r = await this.gameplay(`
local MIL = { FORMATION_CLASS_LAND_COMBAT = true, FORMATION_CLASS_NAVAL = true, FORMATION_CLASS_AIR = true, FORMATION_CLASS_SUPPORT = true }
local out = {}
for _, p in ipairs(PlayerManager.GetAliveMajors()) do
  local cnt = {}
  for _, u in p:GetUnits():Members() do
    local row = GameInfo.Units[u:GetType()]
    if row and MIL[row.FormationClass] then cnt[row.UnitType] = (cnt[row.UnitType] or 0) + 1 end
  end
  local parts = {}
  for t, n in pairs(cnt) do parts[#parts+1] = t .. "=" .. n .. "=" .. Locale.Lookup(GameInfo.Units[t].Name) end
  out[#out+1] = p:GetID() .. ":" .. table.concat(parts, ",")
end
print("LLMR|" .. table.concat(out, ";"))`);
    const out = {};
    for (const part of String(r[0] || '').split(';')) {
      const i = part.indexOf(':');
      const id = Number(part.slice(0, i));
      if (!Number.isFinite(id)) continue;
      out[id] = {};
      for (const u of part.slice(i + 1).split(',').filter(Boolean)) {
        const [type, n, ...name] = u.split('=');
        out[id][type] = { count: Number(n) || 0, name: name.join('=') || type };
      }
    }
    return out;
  }

  // Передать n юнитов типа unitType от from к to: юнит создаётся у получателя (в столице, корабль — в прибрежном
  // городе) и только потом удаляется у дающего; повреждения сохраняются. Возвращает [«передано|город»].
  async transferUnits(from, to, unitType, n) {
    return this.gameplay(`
local from, to, n = ${int(from)}, ${int(to)}, ${int(n)}
local row = GameInfo.Units[${luaString(unitType)}]
if row == nil then error("нет такого юнита") end
local list = {}
for _, u in Players[from]:GetUnits():Members() do
  if u:GetType() == row.Index and not u:IsDead() then list[#list+1] = u end
  if #list >= n then break end
end
if #list < n then error("у передающей стороны нет " .. n .. " таких юнитов") end
local recv = Players[to]
local city = recv:GetCities():GetCapitalCity()
if row.Domain == "DOMAIN_SEA" then
  city = nil
  for _, c in recv:GetCities():Members() do
    for dir = 0, 5 do
      local p = Map.GetAdjacentPlot(c:GetX(), c:GetY(), dir)
      if p and p:IsWater() and not p:IsLake() then city = c break end
    end
    if city then break end
  end
  if city == nil then error("у получателя нет прибрежного города для корабля") end
end
if city == nil then error("у получателя нет городов") end
local known = {}
for _, u in recv:GetUnits():Members() do known[u:GetID()] = true end
local done = 0
for _, old in ipairs(list) do
  local dmg = old:GetDamage()
  UnitManager.InitUnitValidAdjacentHex(to, row.UnitType, city:GetX(), city:GetY())
  local created = nil
  for _, u in recv:GetUnits():Members() do
    if not known[u:GetID()] then known[u:GetID()] = true; if u:GetType() == row.Index then created = u end end
  end
  if created then
    pcall(function() created:SetDamage(dmg) end)
    UnitManager.Kill(old, false)
    done = done + 1
  end
end
print("LLMR|" .. done .. "|" .. Locale.Lookup(city:GetName()))`);
  }

  // Сдвиг отношения стандартного ИИ лидера aiPid к игроку targetPid
  adjustOpinion(aiPid, targetPid, delta) {
    return this.gameplay(
      `Players[${int(aiPid)}]:GetAi_Diplomacy():AdjustBaseDiplomacy(${int(targetPid)}, ${int(delta)}); print("LLMR|ok")`);
  }

  declareWar(a, b) {
    return this.gameplay(
      `local d = Players[${int(a)}]:GetDiplomacy()\n` +
      `if d:IsAtWarWith(${int(b)}) then print("LLMR|already") return end\n` +
      `d:DeclareWarOn(${int(b)}, WarTypes.FORMAL_WAR, true); print("LLMR|ok")`);
  }

  // Объявленная дружба (как в отладочной панели игры Diplomacy.ltp) — с обеих сторон
  declareFriendship(a, b) {
    return this.gameplay(
      `local da, db = Players[${int(a)}]:GetDiplomacy(), Players[${int(b)}]:GetDiplomacy()\n` +
      `if da.SetHasDeclaredFriendship == nil then print("LLMR|noapi") return end\n` +
      `da:SetHasDeclaredFriendship(${int(b)}, true); db:SetHasDeclaredFriendship(${int(a)}, true); print("LLMR|ok")`);
  }

  // Снять объявленную дружбу с обеих сторон (обратимо, проверено в живой игре)
  removeFriendship(a, b) {
    return this.gameplay(
      `local da, db = Players[${int(a)}]:GetDiplomacy(), Players[${int(b)}]:GetDiplomacy()\n` +
      `da:SetHasDeclaredFriendship(${int(b)}, false); db:SetHasDeclaredFriendship(${int(a)}, false); print("LLMR|ok")`);
  }

  // Настоящий союз в игре (состояние «Союз», проверено в живой игре). Снять его этим же API нельзя —
  // союз заканчивается войной, поэтому используем только для договора вида alliance.
  declareAlliance(a, b) {
    return this.gameplay(
      `local da, db = Players[${int(a)}]:GetDiplomacy(), Players[${int(b)}]:GetDiplomacy()\n` +
      `if da.SetHasAllied == nil then print("LLMR|noapi") return end\n` +
      `da:SetHasAllied(${int(b)}, true); db:SetHasAllied(${int(a)}, true); print("LLMR|ok")`);
  }

  makePeace(a, b) {
    return this.gameplay(
      `local d = Players[${int(a)}]:GetDiplomacy()\n` +
      `if not d:IsAtWarWith(${int(b)}) then print("LLMR|notwar") return end\n` +
      `if d.CanMakePeaceWith ~= nil and not d:CanMakePeaceWith(${int(b)}) then print("LLMR|cannot") return end\n` +
      `d:MakePeaceWith(${int(b)}, true); print("LLMR|ok")`);
  }
}

function int(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) throw new Error('ожидалось число: ' + n);
  return v;
}

// Lua-сериализатор отдаёт пустые таблицы как [] — приводим к объектам
function normalizeSnapshot(s) {
  const obj = (x) => (x && !Array.isArray(x) && typeof x === 'object' ? x : {});
  s.resNames = obj(s.resNames);
  s.players = Array.isArray(s.players) ? s.players : [];
  for (const p of s.players) {
    p.strategic = obj(p.strategic);
    p.luxury = obj(p.luxury);
    p.relations = obj(p.relations);
  }
  s.byId = new Map(s.players.map((p) => [p.id, p]));
  return s;
}
