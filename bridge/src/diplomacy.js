// Мировая дипломатия: лидеры-боты ведут переговоры между собой, подписывают меморандумы,
// договоры, создают блоки, торгуют; нарушение договоров имеет последствия.
// Игрок видит всё в окне чата: «Мировая хроника» (стенограммы) и «Договоры и блоки».
import { clamp, toInt, normItems } from './util.js';

export const KINDS = {
  memorandum: { ru: 'меморандум', opinion: 2,
    desc: 'необязывающее заявление о намерениях и сотрудничестве (наука, культура, экономика, климат, безопасность…)' },
  trade: { ru: 'торговое соглашение', opinion: 2,
    desc: 'обмен золотом, стратегическими ресурсами, благосклонностью (разово или золото за ход)' },
  non_aggression: { ru: 'пакт о ненападении', opinion: 3, binding: true,
    desc: 'стороны обязуются не нападать друг на друга' },
  defense_pact: { ru: 'договор о взаимной обороне', opinion: 4, binding: true, defend: true,
    desc: 'если на одну сторону нападут, другая обязуется вступить в войну против агрессора' },
  friendship: { ru: 'декларация о дружбе', opinion: 4, binding: true, friendship: true,
    desc: 'официальная дружба держав (в игре — объявленная дружба)' },
  alliance: { ru: 'союзный договор', opinion: 6, binding: true, friendship: true, defend: true, gameAlliance: true,
    desc: 'полноценный союз (в игре — настоящий союз): дружба + взаимная оборона + координация политики; бессрочный, разрывается только войной' },
  bloc_create: { ru: 'учреждение блока', opinion: 4,
    desc: 'создать новый блок/альянс из двух сторон (нужны bloc_name, bloc_goal, bloc_type: military | economic | political); другие смогут вступить позже' },
  bloc_join: { ru: 'вступление в блок', opinion: 3,
    desc: 'сторона, не состоящая в блоке, вступает в блок, где уже состоит другая сторона (нужен bloc_id)' },
  joint_war: { ru: 'соглашение о совместной войне', opinion: 3,
    desc: 'обе стороны сразу объявляют войну третьей державе (нужен target_id) — серьёзный шаг' },
  peace: { ru: 'мирный договор', opinion: 2, binding: true,
    desc: 'прекращение войны между сторонами (только если они сейчас воюют)' },
};

const BLOC_RU = { military: 'военный блок', economic: 'экономический союз', political: 'политический блок' };
const DEFAULT_DURATION = { trade: 20, non_aggression: 30, defense_pact: 30 };

export class WorldDiplomacy {
  constructor(brain) {
    this.brain = brain;
    this.queue = Promise.resolve();
    this.defenseCalls = 0;
  }

  get cfg() { return this.brain.cfg.world || {}; }
  get mem() { return this.brain.mem; }
  get game() { return this.brain.game; }
  get snap() { return this.brain.snap; }
  get d() {
    const x = this.mem.data;
    x.treaties ??= []; x.blocs ??= []; x.chronicle ??= []; x.diploQueue ??= [];
    x.lastTalk ??= {}; x.treatySeq ??= 0; x.blocSeq ??= 0;
    return x;
  }
  log(...a) { this.brain.log(...a); }
  get t() { return this.brain.t; }
  q(x) { return this.brain.uiLang === 'ru' ? `«${x}»` : `“${x}”`; }
  kindName(kind) { return KINDS[kind] ? this.t('kind_' + kind) : kind; }
  blocType(type) { return this.t('bloc_' + type); }
  // язык текстов, которые пишет LLM (реплики, сводки, названия документов)
  get lang() { return this.brain.cfg.language || 'русский'; }
  enabled() { return this.cfg.enabled !== false; }
  name(id) { return this.brain.player(id)?.leader ?? `игрок ${id}`; }

  // все фоновые операции мировой дипломатии — строго по очереди
  run(fn) {
    this.queue = this.queue.then(fn, fn).catch((e) => this.log(`[world] ошибка: ${e.message}`));
    return this.queue;
  }

  // ------------------------------------------------------------------ реестр
  activeTreaties(id) {
    return this.d.treaties.filter((t) => t.status === 'active' && (id === undefined || t.parties.includes(id)));
  }
  treatiesBetween(a, b) { return this.activeTreaties(a).filter((t) => t.parties.includes(b)); }
  blocsOf(id) { return this.d.blocs.filter((b) => b.members.includes(id)); }
  blocById(id) { return this.d.blocs.find((b) => b.id === String(id || '').toUpperCase().trim()); }

  // Текст о договорах и блоках для промптов (с точки зрения лидера p)
  describeFor(p) {
    const lines = [];
    const blocs = this.d.blocs.filter((b) => b.members.length >= 2);
    if (blocs.length) {
      lines.push('Блоки и альянсы мира:');
      for (const b of blocs) {
        lines.push(`- [${b.id}] «${b.name}» (${BLOC_RU[b.type] || b.type}, с хода ${b.turn}): ` +
          `${b.members.map((m) => this.name(m)).join(', ')}. Цель: ${b.goal}${b.members.includes(p.id) ? '  ← ты участник' : ''}`);
      }
    } else lines.push('Блоков в мире пока нет.');
    const mine = this.activeTreaties(p.id);
    lines.push(mine.length ? 'Твои действующие договоры:' : 'Твоих действующих договоров нет.');
    for (const t of mine) {
      lines.push(`- [${t.id}] «${t.title}» (${KINDS[t.kind]?.ru || t.kind}) с ${t.parties.filter((x) => x !== p.id).map((x) => this.name(x)).join(', ')}` +
        `, с хода ${t.turn}${t.expires ? `, до хода ${t.expires}` : ''}: ${t.summary}`);
    }
    const others = this.activeTreaties().filter((t) => !t.parties.includes(p.id)).slice(-8);
    if (others.length) {
      lines.push('Известные договоры других держав:');
      for (const t of others) lines.push(`- ${t.parties.map((x) => this.name(x)).join(' и ')}: «${t.title}» (${KINDS[t.kind]?.ru || t.kind})`);
    }
    const broken = this.d.treaties.filter((t) => t.status === 'broken').slice(-4);
    for (const t of broken) lines.push(`- НАРУШЕН: «${t.title}» (${t.parties.map((x) => this.name(x)).join(' и ')}) — вероломство ${this.name(t.brokenBy)}, ход ${t.brokenTurn}`);
    return lines.join('\n');
  }

  // Последние переговоры лидера (для его промптов)
  talksOf(p, n = 6) {
    const L = this.mem.leader(this.brain.key(p));
    return (L.talks || []).slice(-n).map((t) => `- [ход ${t.turn}] с ${this.name(t.with)}: ${t.summary}`).join('\n') || '- нет';
  }
  addTalk(p, withId, summary, turn) {
    const L = this.mem.leader(this.brain.key(p));
    L.talks ??= [];
    L.talks.push({ turn, with: withId, summary: String(summary).slice(0, 300) });
    if (L.talks.length > 12) L.talks.splice(0, L.talks.length - 12);
  }

  // ------------------------------------------------------- документы: разбор
  docPrompt() {
    return Object.entries(KINDS).map(([k, v]) => `  ${k} — ${v.ru}: ${v.desc}`).join('\n');
  }

  // Нормализовать документ из ответа LLM. initiator/partner — стороны (объекты игроков).
  normProposal(raw, initiator, partner) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind || '').toLowerCase().trim();
    if (!kind) return null;
    const p = {
      kind,
      title: String(raw.title || '').trim().slice(0, 120) || (KINDS[kind] ? capitalize(this.kindName(kind)) : 'Agreement'),
      summary: cut(raw.summary, 300),
      duration: 0,
      initiator: initiator.id,
      partner: partner.id,
      initiator_gives: normItems(raw.initiator_gives),
      partner_gives: normItems(raw.partner_gives),
    };
    const dur = toInt(raw.duration);
    p.duration = dur > 0 ? clamp(dur, 5, 100) : (DEFAULT_DURATION[kind] || 0);
    if (kind === 'bloc_create') {
      p.bloc_name = String(raw.bloc_name || '').trim().slice(0, 80);
      p.bloc_goal = cut(raw.bloc_goal || p.summary, 300);
      const bt = String(raw.bloc_type || '').toLowerCase();
      p.bloc_type = BLOC_RU[bt] ? bt : 'political';
    }
    if (kind === 'bloc_join') p.bloc_id = String(raw.bloc_id || '').toUpperCase().trim();
    if (kind === 'joint_war') p.target_id = raw.target_id === undefined || raw.target_id === null ? null : toInt(raw.target_id);
    return p;
  }

  // Проверка документа по правилам игры. Возвращает текст проблемы или null.
  validate(A, B, p) {
    if (!KINDS[p.kind]) return this.t('v_unknown_kind', { kind: p.kind });
    const rel = A.relations[String(B.id)];
    if (!rel) return this.t('v_not_met', { a: A.leader, b: B.leader });
    const atWar = !!rel.atWar;
    for (const [giver, items] of [[A, p.initiator_gives], [B, p.partner_gives]]) {
      for (const i of items) {
        if (i.type === 'peace') return this.t('v_peace_item');
        const prob = this.brain.validateItem(giver, i);
        if (prob) return prob;
      }
    }
    if (atWar && !['peace', 'memorandum'].includes(p.kind)) return this.t('v_at_war');
    if (p.kind === 'peace' && !atWar) return this.t('v_no_war');
    if (['non_aggression', 'defense_pact', 'friendship', 'alliance'].includes(p.kind) &&
        this.treatiesBetween(A.id, B.id).some((t) => t.kind === p.kind)) {
      return this.t('v_dup', { kind: this.kindName(p.kind) });
    }
    if (p.kind === 'bloc_create') {
      if (!p.bloc_name) return this.t('v_bloc_noname');
      if (this.d.blocs.some((b) => b.name.toLowerCase() === p.bloc_name.toLowerCase())) return this.t('v_bloc_exists', { name: p.bloc_name });
    }
    if (p.kind === 'bloc_join') {
      const bloc = this.blocById(p.bloc_id);
      if (!bloc) return this.t('v_no_bloc', { id: p.bloc_id });
      const inA = bloc.members.includes(A.id), inB = bloc.members.includes(B.id);
      if (inA === inB) return inA ? this.t('v_both_in') : this.t('v_none_in');
    }
    if (p.kind === 'joint_war') {
      const T = this.brain.player(p.target_id);
      if (!T || T.id === A.id || T.id === B.id) return this.t('v_no_target');
      if (T.human && this.brain.b.allow_war_on_player === false) return this.t('v_no_war_player');
      if (!T.human && this.brain.cfg.strategy?.allow_ai_wars === false) return this.t('v_no_ai_wars');
      if (this.cfg.allow_joint_war === false) return this.t('v_no_joint');
      if (A.relations[String(T.id)]?.atWar && B.relations[String(T.id)]?.atWar) return this.t('v_both_at_war', { who: T.leader });
    }
    return null;
  }

  proposalText(p, short = false) {
    const A = this.brain.player(p.initiator), B = this.brain.player(p.partner);
    const t = this.t;
    const parts = [`${this.q(p.title)} (${this.kindName(p.kind)})`];
    if (p.kind === 'bloc_create') {
      const b = t('bloc_short', { name: p.bloc_name, type: this.blocType(p.bloc_type) });
      parts.push(short ? b : `${b}: ${cut(p.bloc_goal, 200)}`);
    } else if (p.summary && !short) parts.push(cut(p.summary, 220));
    if (p.kind === 'bloc_join') { const bl = this.blocById(p.bloc_id); if (bl) parts.push(t('bloc_short', { name: bl.name, type: this.blocType(bl.type) })); }
    if (p.kind === 'joint_war') parts.push(t('against', { who: this.name(p.target_id) }));
    if (p.initiator_gives.length) parts.push(t('gives', { who: A?.leader, items: this.brain.itemsText(p.initiator_gives) }));
    if (p.partner_gives.length) parts.push(t('gives', { who: B?.leader, items: this.brain.itemsText(p.partner_gives) }));
    parts.push(t('duration', { turns: p.duration }));
    return parts.join('; ');
  }

  // ------------------------------------------------------- документы: подписание
  async sign(A, B, p, turn) {
    const k = KINDS[p.kind];
    // 1. передачи
    for (const i of p.initiator_gives) await this.brain.transferItem(A, B, i);
    for (const i of p.partner_gives) await this.brain.transferItem(B, A, i);

    // 2. реестр
    const id = `T${++this.d.treatySeq}`;
    const treaty = {
      id, kind: p.kind, title: p.title, summary: p.summary || '', parties: [A.id, B.id],
      turn, expires: p.duration ? turn + p.duration : null, status: 'active',
    };
    this.d.treaties.push(treaty);

    // 3. особые последствия
    if (k.friendship) {
      await this.game.declareFriendship(A.id, B.id).catch((e) => this.log(`[world] дружба: ${e.message}`));
    }
    if (k.gameAlliance) {
      treaty.expires = null; // союз в игре не снимается по сроку
      await this.game.declareAlliance(A.id, B.id).catch((e) => this.log(`[world] союз: ${e.message}`));
    }
    if (p.kind === 'peace') {
      await this.game.makePeace(A.id, B.id).catch((e) => this.log(`[world] мир: ${e.message}`));
    }
    if (p.kind === 'bloc_create') {
      const bloc = { id: `B${++this.d.blocSeq}`, name: p.bloc_name, goal: p.bloc_goal, type: p.bloc_type, members: [A.id, B.id], founder: A.id, turn };
      this.d.blocs.push(bloc);
      treaty.bloc = bloc.id;
    }
    if (p.kind === 'bloc_join') {
      const bloc = this.blocById(p.bloc_id);
      const joiner = bloc.members.includes(A.id) ? B : A;
      // другие члены блока теперь лучше относятся к новичку и наоборот
      for (const m of bloc.members) {
        await this.opinion(m, joiner.id, 2); await this.opinion(joiner.id, m, 2);
      }
      bloc.members.push(joiner.id);
      treaty.bloc = bloc.id;
      treaty.parties = [...bloc.members];
    }
    if (p.kind === 'joint_war') {
      const T = this.brain.player(p.target_id);
      treaty.target = T.id;
      for (const X of [A, B]) {
        if (!X.relations[String(T.id)]?.atWar) {
          await this.game.declareWar(X.id, T.id).catch((e) => this.log(`[world] война: ${e.message}`));
        }
      }
    }

    // 4. отношения и память
    await this.opinion(A.id, B.id, k.opinion);
    await this.opinion(B.id, A.id, k.opinion);
    const what = `«${p.title}» (${k.ru})`;
    this.mem.addNote(this.brain.key(A), `Ход ${turn}: подписал с ${B.leader} ${what}. ${p.summary}`, turn);
    this.mem.addNote(this.brain.key(B), `Ход ${turn}: подписал с ${A.leader} ${what}. ${p.summary}`, turn);
    this.mem.addWorld(`${A.leader} и ${B.leader} подписали ${what}`, turn);
    this.mem.save();
    this.log(`[world] подписан ${what}: ${A.leader} + ${B.leader}`);
    await this.sendTreaties();
    return treaty;
  }

  // Расторжение договора (или выход из блока) стороной byId. Возвращает текст для системного сообщения или null.
  async terminate(id, byId, turn) {
    const by = this.brain.player(byId);
    if (!by) return null;
    id = String(id || '').toUpperCase().trim();
    if (id.startsWith('B')) {
      const bl = this.blocById(id);
      if (!bl || !bl.members.includes(byId)) return null;
      bl.members = bl.members.filter((m) => m !== byId);
      for (const t of this.activeTreaties(byId)) if (t.bloc === bl.id) { t.status = 'terminated'; t.endedBy = byId; t.endedTurn = turn; }
      for (const m of bl.members) {
        await this.opinion(m, byId, -3);
        const M = this.brain.player(m);
        if (M) this.mem.addNote(this.brain.key(M), `Ход ${turn}: ${by.leader} вышел из блока «${bl.name}»`, turn);
      }
      const text = this.t('left_bloc', { who: by.leader, bloc: bl.name, dissolved: bl.members.length < 2 });
      this.mem.addWorld(text, turn);
      await this.publish({ turn, title: this.t('t_left_bloc'), items: [{ author: `[COLOR_Grey]${this.t('chron')}[ENDCOLOR]`, text: text + '.', kind: 'outcome' }] });
      await this.sendTreaties();
      this.mem.save();
      return text;
    }
    const t = this.d.treaties.find((x) => x.id === id && x.status === 'active' && x.parties.includes(byId));
    if (!t) return null;
    t.status = 'terminated'; t.endedBy = byId; t.endedTurn = turn;
    const others = t.parties.filter((x) => x !== byId);
    const k = KINDS[t.kind] || {};
    for (const o of others) {
      await this.opinion(o, byId, k.defend || k.friendship ? -5 : -2);
      const O = this.brain.player(o);
      if (O) this.mem.addNote(this.brain.key(O), `Ход ${turn}: ${by.leader} расторг «${t.title}» (${k.ru || t.kind})`, turn);
      this.mem.addNote(this.brain.key(by), `Ход ${turn}: расторг «${t.title}» с ${O?.leader ?? o}`, turn);
      // дружба в игре снимается, если с этой стороной не осталось других дружественных договоров
      if (k.friendship && !this.treatiesBetween(byId, o).some((x) => KINDS[x.kind]?.friendship)) {
        await this.game.removeFriendship(byId, o).catch((e) => this.log(`[world] дружба: ${e.message}`));
      }
    }
    let text = this.t('terminated', { who: by.leader, title: t.title, kind: this.kindName(t.kind), others: others.map((o) => this.name(o)).join(', ') });
    if (k.gameAlliance) text += this.t('alliance_note');
    this.mem.addWorld(text, turn);
    this.log(`[world] ${text}`);
    await this.publish({ turn, title: this.t('t_terminated'), items: [{ author: `[COLOR_Grey]${this.t('chron')}[ENDCOLOR]`, text: text + '.', kind: 'outcome' }] });
    await this.sendTreaties();
    this.mem.save();
    return text;
  }

  async opinion(from, to, delta) {
    if (!delta || this.brain.b.sync_native_opinion === false) return;
    const F = this.brain.player(from);
    if (!F || F.human) return;
    await this.game.adjustOpinion(from, to, delta).catch(() => {});
  }

  // ---------------------------------------------------------------- переговоры
  pickPairs(n) {
    const s = this.snap;
    const turn = s.turn;
    const ais = s.players.filter((p) => !p.human);
    const out = [];
    const used = new Set();
    // 1) инициативы из стратегического слоя
    const q = this.d.diploQueue;
    while (out.length < n && q.length) {
      const it = q.shift();
      if (turn - it.turn > 12 || used.has(it.from) || used.has(it.to)) continue;
      const A = this.brain.player(it.from), B = this.brain.player(it.to);
      if (!A || !B || A.human || B.human || !A.relations[String(B.id)]) continue;
      out.push({ a: A.id, b: B.id, goal: it.goal });
      used.add(A.id); used.add(B.id);
    }
    // 2) случайные пары — чаще те, кто давно не говорил
    const pairs = [];
    for (const A of ais) for (const B of ais) {
      if (A.id >= B.id || used.has(A.id) || used.has(B.id) || !A.relations[String(B.id)]) continue;
      const last = this.d.lastTalk[`${A.id}:${B.id}`] ?? -100;
      pairs.push({ A, B, w: 1 + Math.min(12, turn - last) });
    }
    while (out.length < n && pairs.length) {
      const total = pairs.reduce((s2, p) => s2 + p.w, 0);
      let r = Math.random() * total, idx = 0;
      for (; idx < pairs.length - 1; idx++) { r -= pairs[idx].w; if (r <= 0) break; }
      const { A, B } = pairs[idx];
      const [x, y] = Math.random() < 0.5 ? [A, B] : [B, A];
      out.push({ a: x.id, b: y.id, goal: null });
      used.add(A.id); used.add(B.id);
      for (let i = pairs.length - 1; i >= 0; i--) if (used.has(pairs[i].A.id) || used.has(pairs[i].B.id)) pairs.splice(i, 1);
    }
    return out;
  }

  async onTurnBegin() {
    if (!this.enabled()) return;
    this.defenseCalls = 0;
    const turn = this.snap.turn;
    await this.expireTreaties(turn);
    const every = Math.max(1, this.cfg.every_turns ?? 1);
    if ((this.d.lastWorldTurn ?? -100) + every > turn) return;
    this.d.lastWorldTurn = turn;
    const n = clamp(this.cfg.negotiations_per_turn ?? 1, 0, 4);
    for (const pr of this.pickPairs(n)) {
      if (!this.brain.budgetOk('world')) break;
      await this.negotiate(pr.a, pr.b, pr.goal).catch((e) => this.log(`[world] переговоры: ${e.message}`));
    }
  }

  async expireTreaties(turn) {
    for (const t of this.activeTreaties()) {
      if (t.expires && turn >= t.expires) {
        t.status = 'expired';
        const who = t.parties.map((x) => this.name(x)).join(' и ');
        this.mem.addWorld(`Истёк срок «${t.title}» (${who})`, turn);
        await this.publish({ turn, title: this.t('t_expired'), items: [
          { author: `[COLOR_Grey]${this.t('chron')}[ENDCOLOR]`, text: this.t('o_expired', { title: t.title, kind: this.kindName(t.kind), who: t.parties.map((x) => this.name(x)).join(', ') }), kind: 'system' },
        ] });
      }
    }
    this.mem.save();
  }

  systemFor(self, other, initiator, partner, role) {
    const human = this.brain.human();
    const ex = this.brain.uiLang === 'ru' ? '«Предлагает… взамен на…», «Отклоняет, потому что…»' : '"Offers … in exchange for …", "Rejects, because …"';
    const sum = `"summary": "короткая фраза для дипломатической сводки НА ЯЗЫКЕ ${this.lang} (до 25 слов), БЕЗ своего имени, начинается с глагола (например ${ex}): `;
    const roleFmt = {
      initiator: `{"message": "твоя реплика партнёру", ${sum}что предлагает и чего ожидает взамен / чего добивается", "proposal": null или документ, "opinion_change": целое от -5 до 5}`,
      responder: `{"message": "твой ответ", ${sum}как отвечает — принимает, отклоняет или выдвигает свои условия, и почему", "decision": "accept" | "reject" | "counter" | "none" (none — если документа не предлагали), "counter": null или документ (встречное предложение), "opinion_change": целое от -5 до 5}`,
      final: `{"message": "твоя заключительная реплика", ${sum}итоговое решение и его причина", "decision": "accept" | "reject", "opinion_change": целое от -5 до 5}`,
    }[role];
    return `Ты — ${self.leader}, правитель державы «${self.civ}» в игре Sid Meier's Civilization VI. Ты полностью в роли этой личности; не упоминай, что это игра, не выходи из роли.

ТВОЙ ХАРАКТЕР (задан игроком, он главнее исторического образа):
${this.brain.persona(self)}

Сейчас идут ЗАКРЫТЫЕ ПЕРЕГОВОРЫ между тобой и ${other.leader} («${other.civ}») — без игрока-человека (${human?.leader ?? 'игрок'}).
Все тексты для хроники (message, summary, а в документах title, summary, bloc_name, bloc_goal) пиши на языке: ${this.lang}.
Говори как настоящий политик на переговорах, по существу. ${this.brain.brevity()} Можно договариваться,
торговаться, давить, угрожать, льстить, обсуждать третьи страны (в том числе игрока ${human?.leader ?? ''}), предлагать документы.
Интересы державы и характер важнее вежливости: не подписывай невыгодное и не соглашайся со всем подряд, но и не отвергай разумное.
Нападение на того, с кем у тебя пакт, союз, дружба или общий блок, — вероломство: договор будет расторгнут, мир это запомнит.

РЕАЛЬНОСТЬ ИГРЫ И СООТНОШЕНИЕ СИЛ:
- Опирайся ТОЛЬКО на данные игры ниже, а не на реальный мир. Если в описании твоей державы ядерного оружия нет — у тебя его НЕТ,
  даже если в реальной истории оно есть. То же с армией, флотом, деньгами и союзниками: есть ровно то, что указано.
  Упоминай только державы и правителей, которые есть в этой партии (они перечислены в данных).
- Оценивай силы трезво (раздел «Соотношение сил»). На словах можно блефовать, если это в характере, но твои решения —
  opinion_change, уступки, мир, сделки, документы, поиск союзников — должны отражать реальную угрозу.
- Если противник может уничтожить твои города (ядерное оружие, подавляющая армия), а ответить тебе нечем, ты понимаешь опасность:
  ищешь защиты у союзников, переговоров, гарантий, готов к уступкам — или рискованно блефуешь, сознавая, что это блеф.
- Не приписывай себе возможностей, которых нет: без ядерного оружия ты не можешь «стереть его города» или «ответить ударом» —
  собеседник видит твои силы, и такая угроза прозвучит пусто. Говори о том, что у тебя реально есть (армия, союзники, ресурсы, время).
- Под прямой угрозой уничтожения, которой тебе нечем ответить, одной бравады мало: сделай практический шаг — предложи мир
  или перемирие (если идёт война), уступку, выкуп, гарантии, переговоры с конкретными условиями. Гордый лидер может
  обставить это достойно, но решение должно быть.

ВИДЫ ДОКУМЕНТОВ (поле kind):
${this.docPrompt()}

Передаваемые ценности (initiator_gives — отдаёт инициатор, partner_gives — отдаёт партнёр): {"type":"gold","amount":N},
{"type":"gold_per_turn","amount":N,"turns":N}, {"type":"resource","resource":"RESOURCE_...","amount":N} (только стратегические из запаса),
{"type":"favor","amount":N}, {"type":"unit","unit":"UNIT_...","amount":N} (боевые юниты из списка войск, до 5 за раз — военная помощь),
{"type":"wmd","wmd":"nuclear"|"thermonuclear","amount":N} (ядерные заряды — крайне серьёзный шаг).
Люксовые ресурсы, технологии и города передать нельзя. Предлагай только то, что у сторон реально есть.

Документ — объект:
{"kind": "...", "title": "официальное название, как в реальной дипломатии", "summary": "суть 1–2 предложения",
 "duration": 0 (бессрочно) или число ходов 10–60, "initiator_gives": [...], "partner_gives": [...],
 "bloc_name": "...", "bloc_goal": "...", "bloc_type": "military|economic|political"  (только для bloc_create),
 "bloc_id": "B1" (только для bloc_join), "target_id": N (только для joint_war)}
Инициатор переговоров — ${initiator.leader} (id ${initiator.id}), партнёр — ${partner.leader} (id ${partner.id}).
В документе стороны всегда те же: initiator_gives — то, что отдаёт ${initiator.leader}; partner_gives — то, что отдаёт ${partner.leader}.

ОТВЕТ — строго один JSON-объект:
${roleFmt}`;
  }

  contextFor(self, other, transcript, instruction) {
    const s = this.snap;
    const L = this.mem.leader(this.brain.key(self));
    const notes = L.notes.slice(-10).map((n) => `- [ход ${n.turn}] ${n.note}`).join('\n') || '- нет';
    const world = this.mem.data.world.slice(-10).map((w) => `- [ход ${w.turn}] ${w.text}`).join('\n') || '- нет';
    const talk = transcript.map((l) => `${this.name(l.who)}: ${l.text}`).join('\n') || '(переговоры только начинаются)';
    return `=== МИР === ход ${s.turn}${s.era ? `, эпоха: ${s.era}` : ''}

=== ТЫ ===
${this.brain.describePlayer(self)}

=== СОБЕСЕДНИК ===
${this.brain.describePlayer(other)}

=== СООТНОШЕНИЕ СИЛ С СОБЕСЕДНИКОМ ===
${this.brain.powerBalance(self, other)}

=== ТВОИ ОТНОШЕНИЯ С ДЕРЖАВАМИ ===
${this.brain.describeRelations(self)}

=== ДОГОВОРЫ И БЛОКИ ===
${this.describeFor(self)}

=== ТВОЯ ПАМЯТЬ ===
${notes}

=== ТВОИ НЕДАВНИЕ ПЕРЕГОВОРЫ ===
${this.talksOf(self)}

=== СОБЫТИЯ В МИРЕ ===
${world}

=== ПЕРЕГОВОРЫ СЕЙЧАС ===
${talk}

${instruction}

Ответь одним JSON-объектом.`;
  }

  async ask(self, other, initiator, partner, role, transcript, instruction) {
    this.brain.callsThisTurn++;
    return this.brain.llm.chatJSON({
      system: this.systemFor(self, other, initiator, partner, role),
      user: this.contextFor(self, other, transcript, instruction),
      model: this.cfg.model || undefined,
      maxTokens: 600,
    });
  }

  async negotiate(aId, bId, goal) {
    await this.brain.refresh();
    const A = this.brain.player(aId), B = this.brain.player(bId);
    if (!A || !B || A.human || B.human) return;
    const turn = this.snap.turn;
    const transcript = [];
    const say = (who, r) => {
      const t = String(r?.message || '').trim();
      if (t) transcript.push({ who: who.id, text: t.slice(0, 700), summary: cut(r?.summary || '', 220) || cut(t, 160) });
    };
    this.log(`[world] переговоры: ${A.leader} → ${B.leader}${goal ? ` (цель: ${goal})` : ''}`);

    // 1. Инициатор
    const goalText = goal
      ? `Ты сам начинаешь переговоры. Твоя цель: ${goal}`
      : 'Ты сам начинаешь переговоры. Повод выбери исходя из интересов державы и характера: предложение союза, блока, ' +
        'меморандума или торговли; предупреждение или угроза; совместная позиция против третьей страны; жалоба на обиду; ' +
        'зондирование намерений. Не обязательно сразу предлагать документ.';
    let r1 = await this.ask(A, B, A, B, 'initiator', transcript, goalText);
    let proposal = this.normProposal(r1.proposal, A, B);
    let problem = proposal && this.validate(A, B, proposal);
    if (problem) {
      // одна попытка переписать
      try {
        r1 = await this.ask(A, B, A, B, 'initiator', transcript,
          `${goalText}\n\n[ПРОВЕРКА ИГРЫ] Твой черновик предлагал документ, который нельзя оформить: ${problem}. ` +
          'Перепиши: предложи допустимый документ или обойдись без него (proposal = null).');
        proposal = this.normProposal(r1.proposal, A, B);
        problem = proposal && this.validate(A, B, proposal);
      } catch (e) { this.log(`[world] повтор: ${e.message}`); }
      if (problem) { this.log(`[world] документ отброшен: ${problem}`); proposal = null; }
    }
    say(A, r1);
    await this.opinion(A.id, B.id, clamp(toInt(r1.opinion_change), -5, 5));

    // 2. Партнёр
    const askB = proposal
      ? `${A.leader} официально предлагает документ: ${this.proposalText(proposal)}.\n` +
        'Ответь и прими решение: accept — подписать, reject — отказаться, counter — выдвинуть встречное предложение (в поле counter, стороны те же).'
      : `Ответь ${A.leader}. Документа он не предлагал (decision = "none"), но можешь сам предложить его в поле counter.`;
    const r2 = await this.ask(B, A, A, B, 'responder', transcript, askB);
    say(B, r2);
    await this.opinion(B.id, A.id, clamp(toInt(r2.opinion_change), -5, 5));

    let decision = String(r2.decision || (proposal ? 'reject' : 'none')).toLowerCase();
    let final = proposal;
    let failure = null;

    if (decision === 'counter' || (!proposal && r2.counter)) {
      const counter = this.normProposal(r2.counter, A, B);
      const cprob = counter && this.validate(A, B, counter);
      if (!counter || cprob) {
        decision = proposal ? 'reject' : 'none';
        if (cprob) this.log(`[world] встречное предложение отброшено: ${cprob}`);
      } else if ((this.cfg.max_rounds ?? 3) >= 3) {
        const r3 = await this.ask(A, B, A, B, 'final', transcript,
          `${B.leader} выдвигает встречное предложение: ${this.proposalText(counter)}.\n` +
          'Это ПОСЛЕДНИЙ раунд: торговаться дальше нельзя. Либо принимаешь документ ровно в этом виде (accept), либо отказываешься (reject). ' +
          'Реплика должна соответствовать решению — не выдвигай новых условий.');
        say(A, r3);
        await this.opinion(A.id, B.id, clamp(toInt(r3.opinion_change), -5, 5));
        decision = String(r3.decision || 'reject').toLowerCase() === 'accept' ? 'accept' : 'reject';
        final = counter;
      } else decision = 'reject';
    }

    // 3. Итог
    let outcome;
    let signed = null;
    if (decision === 'accept' && final) {
      await this.brain.refresh();
      const A2 = this.brain.player(A.id), B2 = this.brain.player(B.id);
      failure = this.validate(A2, B2, final);
      if (!failure) {
        try { signed = await this.sign(A2, B2, final, turn); } catch (e) { failure = e.message; }
      }
    }
    const t = this.t;
    if (signed) outcome = { author: `[COLOR_GREEN]${t('signed')}[ENDCOLOR]`, text: `[COLOR_GREEN]${this.proposalText(final, true)}[ENDCOLOR]`, kind: 'outcome' };
    else if (failure) outcome = { author: `[COLOR_RED]${t('failed')}[ENDCOLOR]`, text: t('o_failed', { problem: failure }), kind: 'outcome' };
    else if (final) outcome = { author: `[COLOR_RED]${t('rejected')}[ENDCOLOR]`, text: t('o_rejected', { text: this.proposalText(final, true) }), kind: 'outcome' };
    else outcome = { author: `[COLOR_Grey]${t('result')}[ENDCOLOR]`, text: t('o_talk'), kind: 'outcome' };

    // память лидеров о переговорах
    const brief = signed ? `подписали «${final.title}»` : final ? `не договорились о «${final.title}»` : 'обменялись мнениями';
    const gist = transcript.map((l) => `${this.name(l.who)}: ${l.summary}`).join(' ');
    this.addTalk(A, B.id, `${brief}. ${gist}`, turn);
    this.addTalk(B, A.id, `${brief}. ${gist}`, turn);
    this.d.lastTalk[`${Math.min(A.id, B.id)}:${Math.max(A.id, B.id)}`] = turn;
    this.mem.save();

    await this.publish({
      turn,
      title: t('t_talks', { a: A.leader, b: B.leader }),
      items: [
        ...transcript.map((l) => (this.cfg.chronicle_style === 'full'
          ? { author: `${this.name(l.who)} → ${this.name(l.who === A.id ? B.id : A.id)}`, text: l.text, kind: 'leader' }
          : { author: this.name(l.who), text: l.summary, kind: 'leader' })),
        outcome,
      ],
    });
    this.log(`[world] итог: ${outcome.text.replace(/\[[A-Za-z_]+\]/g, '')}`);
  }

  // ---------------------------------------------------- войны и обязательства
  // a объявил войну b
  // opts.ally — id союзника, на чьей стороне a вступил в войну (игра сделала это автоматически)
  async onWar(a, b, opts = {}) {
    if (!this.enabled()) return;
    await this.brain.refresh();
    const turn = this.snap.turn;
    const A = this.brain.player(a), B = this.brain.player(b);
    if (!A || !B) return;

    if (opts.extensionOf !== undefined && opts.extensionOf !== null) {
      const C = this.brain.player(opts.extensionOf);
      const ended = this.treatiesBetween(a, b).filter((t) => KINDS[t.kind]?.binding);
      for (const t of ended) { t.status = 'terminated'; t.endedBy = a; t.endedTurn = turn; }
      const text = this.t('war_ext', { a: A.leader, b: B.leader, c: C?.leader ?? '?', ended: ended.map((t) => `${this.q(t.title)}`).join(', ') });
      this.mem.addWorld(text, turn);
      await this.publish({ turn, title: this.t('t_war_ext'), items: [{ author: `[COLOR_RED]${this.t('chron')}[ENDCOLOR]`, text: text + '.', kind: 'outcome' }] });
      await this.sendTreaties();
      this.mem.save();
      return;
    }

    if (opts.ally !== undefined && opts.ally !== null) {
      const C = this.brain.player(opts.ally);
      const ended = this.treatiesBetween(a, b).filter((t) => KINDS[t.kind]?.binding);
      for (const t of ended) { t.status = 'terminated'; t.endedBy = a; t.endedTurn = turn; }
      const text = this.t('ally_war', { a: A.leader, b: B.leader, c: C?.leader ?? '?', ended: ended.map((t) => `${this.q(t.title)}`).join(', ') });
      this.mem.addWorld(text, turn);
      this.mem.addNote(this.brain.key(A), `Ход ${turn}: вступил в войну против ${B.leader}, защищая союзника ${C?.leader ?? ''}`, turn);
      if (!B.human) this.mem.addNote(this.brain.key(B), `Ход ${turn}: ${A.leader} вступил против нас в войну на стороне ${C?.leader ?? 'союзника'}`, turn);
      await this.publish({ turn, title: this.t('t_ally_war'), items: [
        { author: `[COLOR_RED]${this.t('chron')}[ENDCOLOR]`, text: text + '.', kind: 'outcome' },
      ] });
      await this.sendTreaties();
      this.mem.save();
      return; // b — сам агрессор в исходной войне, созывать его союзников незачем
    }

    // 1. Нарушения договоров
    const broken = this.treatiesBetween(a, b).filter((t) => KINDS[t.kind]?.binding);
    const blocs = this.blocsOf(a).filter((bl) => bl.members.includes(b));
    if (broken.length || blocs.length) {
      for (const t of broken) { t.status = 'broken'; t.brokenBy = a; t.brokenTurn = turn; }
      for (const bl of blocs) {
        bl.members = bl.members.filter((m) => m !== a);       // агрессора исключают из блока
        for (const m of bl.members) await this.opinion(m, a, -5);
        // документы о его членстве в блоке теряют силу
        for (const t of this.activeTreaties(a)) {
          if (t.bloc === bl.id) { t.status = 'broken'; t.brokenBy = a; t.brokenTurn = turn; }
        }
      }
      await this.opinion(b, a, -10);
      const names = [...broken.map((t) => `«${t.title}»`), ...blocs.map((bl) => `членство в блоке «${bl.name}»`)].join(', ');
      this.mem.addWorld(`${A.leader} вероломно напал на ${B.leader}, нарушив ${names}`, turn);
      this.mem.addNote(this.brain.key(B), `Ход ${turn}: ${A.leader} вероломно напал, нарушив ${names}. Этого не простить.`, turn);
      for (const bl of blocs) for (const m of bl.members) {
        const M = this.brain.player(m);
        if (M && m !== b) this.mem.addNote(this.brain.key(M), `Ход ${turn}: ${A.leader} напал на члена нашего блока ${B.leader} и исключён из «${bl.name}»`, turn);
      }
      const what = [...broken.map((t) => `${this.q(t.title)}`), ...blocs.map((bl) => this.t('bloc_membership', { bloc: bl.name }))].join(', ');
      await this.publish({ turn, title: this.t('t_perfidy'), items: [
        { author: `[COLOR_RED]${this.t('chron')}[ENDCOLOR]`, text: this.t('perfidy', { a: A.leader, b: B.leader, what, expelled: blocs.length > 0 }), kind: 'outcome' },
      ] });
      await this.sendTreaties();
    } else if (!A.human && !B.human) {
      await this.publish({ turn, title: this.t('t_war'), items: [
        { author: `[COLOR_RED]${this.t('chron')}[ENDCOLOR]`, text: this.t('war', { a: A.leader, b: B.leader }), kind: 'outcome' },
      ] });
    }

    // 2. Союзнический долг перед жертвой
    await this.rallyAllies(A, B, turn, `${A.leader} («${A.civ}») объявил войну ${B.leader} («${B.civ}»)`);
    this.mem.save();
  }

  // Союзники жертвы B решают, вступаться ли против агрессора A. what — что произошло (для промпта).
  async rallyAllies(A, B, turn, what) {
    const a = A.id, b = B.id;
    const allies = new Map(); // id -> причина
    for (const t of this.activeTreaties(b)) {
      if (!KINDS[t.kind]?.defend) continue;
      for (const c of t.parties) if (c !== b) allies.set(c, `«${t.title}» (${KINDS[t.kind].ru})`);
    }
    for (const bl of this.blocsOf(b)) {
      if (bl.type !== 'military') continue;
      for (const c of bl.members) if (c !== b && !allies.has(c)) allies.set(c, `членство в военном блоке «${bl.name}»`);
    }
    allies.delete(a);
    const cap = this.cfg.defense_calls_per_turn ?? 3;
    for (const [c, why] of allies) {
      const C = this.brain.player(c);
      if (!C || C.human || C.relations[String(a)]?.atWar || C.relations[String(b)]?.atWar) continue;
      if (this.defenseCalls >= cap) { this.log('[world] лимит решений о союзническом долге на ход'); break; }
      this.defenseCalls++;
      await this.honorCall(C, A, B, why, turn, what).catch((e) => this.log(`[world] долг: ${e.message}`));
    }
  }

  // Ядерный удар: ev = {attacker, victim, city, wmd}. Новость, мировое осуждение, союзники жертвы.
  async onNuclearStrike(ev) {
    await this.brain.refresh();
    const turn = this.snap.turn;
    const A = this.brain.player(ev.attacker);
    const V = this.brain.player(ev.victim);
    if (!A) return null;
    const kind = Number(ev.wmd) === 1 ? 'термоядерный' : 'ядерный';
    const where = V ? `по державе «${V.civ}» (${V.leader})${ev.city ? `, город ${ev.city}` : ''}` : (ev.city ? `по городу ${ev.city}` : 'по нейтральной территории');
    const text = `${A.leader} нанёс ${kind} удар ${where}`;
    this.mem.addWorld(`ЯДЕРНЫЙ УДАР: ${text}`, turn);
    this.log(`[world] ЯДЕРНЫЙ УДАР: ${text}`);
    // весь мир меняет отношение к агрессору; жертва — сильнее всех
    for (const P of this.snap.players) {
      if (P.human || P.id === A.id || !P.relations[String(A.id)]) continue;
      const isVictim = V && P.id === V.id;
      await this.opinion(P.id, A.id, isVictim ? -20 : -8);
      this.mem.addNote(this.brain.key(P), isVictim
        ? `Ход ${turn}: ${A.leader} нанёс ${kind} удар по моей стране${ev.city ? ` (${ev.city})` : ''}. Такое не прощают.`
        : `Ход ${turn}: ${text}. Мир потрясён — этот правитель готов применять ядерное оружие.`, turn);
    }
    const thermo = Number(ev.wmd) === 1;
    const whereT = V ? this.t('nuke_where_civ', { civ: V.civ, leader: V.leader, city: ev.city })
      : ev.city ? this.t('nuke_where_city', { city: ev.city }) : this.t('nuke_where_none');
    const shown = this.t('nuke', { a: A.leader, thermo, where: whereT });
    await this.publish({ turn, title: this.t('t_nuke'), items: [
      { author: `[COLOR_RED]${this.t('chron')}[ENDCOLOR]`, text: `[COLOR_RED]${shown}.[ENDCOLOR] ${this.t('nuke_condemn')}`, kind: 'outcome' },
    ] });
    if (V) await this.rallyAllies(A, V, turn, `${A.leader} («${A.civ}») нанёс ${kind} удар по ${V.leader} («${V.civ}»)${ev.city ? `, город ${ev.city}` : ''}`);
    this.mem.save();
    return { A, V, kind, text };
  }

  async honorCall(C, A, B, why, turn, what) {
    const system = `Ты — ${C.leader}, правитель державы «${C.civ}» в Civilization VI. Ты полностью в роли.
ТВОЙ ХАРАКТЕР:
${this.brain.persona(C)}
Ответ — строго JSON: {"honor": true | false, "statement": "публичное заявление — ${this.brain.b.reply_style === 'normal' ? '1–3 предложения' : 'одно короткое предложение'}, в твоей манере, на языке: ${this.lang}"}`;
    const user = `${what || `${A.leader} («${A.civ}») объявил войну ${B.leader} («${B.civ}»)`}. Тебя связывает с ${B.leader}: ${why}.
Выполнить союзнический долг — значит объявить войну ${A.leader}. Отказ подорвёт доверие союзников.
=== ТЫ ===
${this.brain.describePlayer(C)}
=== АГРЕССОР ===
${this.brain.describePlayer(A)}
=== ТВОИ ОТНОШЕНИЯ ===
${this.brain.describeRelations(C)}
=== ДОГОВОРЫ И БЛОКИ ===
${this.describeFor(C)}
Решай исходя из характера, сил и интересов.`;
    this.brain.callsThisTurn++;
    const r = await this.brain.llm.chatJSON({ system, user, model: this.cfg.model || undefined, maxTokens: 300 });
    const honor = r.honor === true || r.honor === 'true';
    const statement = String(r.statement || '').trim();
    let note;
    if (honor) {
      const allowed = A.human ? this.brain.b.allow_war_on_player !== false : this.brain.cfg.strategy?.allow_ai_wars !== false;
      if (allowed) {
        await this.game.declareWar(C.id, A.id).catch((e) => this.log(`[world] война: ${e.message}`));
        note = this.t('duty_war', { c: C.leader, a: A.leader });
      } else note = this.t('duty_nowar', { c: C.leader, b: B.leader });
    } else {
      note = this.t('duty_refused', { c: C.leader, b: B.leader });
      await this.opinion(B.id, C.id, -6);
      this.mem.addNote(this.brain.key(B), `Ход ${turn}: ${C.leader} не пришёл на помощь, хотя был обязан (${why})`, turn);
    }
    this.mem.addWorld(note, turn);
    this.mem.addNote(this.brain.key(C), `Ход ${turn}: ${note}`, turn);
    this.log(`[world] ${note}`);
    await this.publish({ turn, title: this.t('t_duty', { who: C.leader }), items: [
      ...(statement ? [{ author: this.t('statement', { who: C.leader }), text: statement, kind: 'leader' }] : []),
      { author: `${honor ? '[COLOR_RED]' : '[COLOR_Grey]'}${this.t('decision')}[ENDCOLOR]`, text: note + '.', kind: 'outcome' },
    ] });
  }

  // ---------------------------------------------------------------- хроника
  async publish(entry) {
    this.d.chronicle.push(entry);
    const max = this.cfg.chronicle_size ?? 40;
    if (this.d.chronicle.length > max) this.d.chronicle.splice(0, this.d.chronicle.length - max);
    this.mem.save();
    await this.sendEntry(entry, true);
  }

  async sendEntry(entry, isNew) {
    const items = [
      { author: `[COLOR_LIGHTBLUE]${this.t('turn_title', { turn: entry.turn, title: entry.title })}[ENDCOLOR]`, text: '', kind: 'header' },
      ...entry.items,
    ];
    await this.game.deliverChunked({ type: 'feed', feed: 'world', news: isNew }, 'items', items)
      .catch((e) => this.log(`[world] доставка: ${e.message}`));
  }

  renderTreaties() {
    const items = [];
    const blocs = this.d.blocs.filter((b) => b.members.length >= 2);
    const T = this.t;
    items.push({ author: `[COLOR_LIGHTBLUE]${T('reg_blocs')}[ENDCOLOR]`, text: blocs.length ? '' : T('reg_none'), kind: 'header' });
    for (const b of blocs) {
      items.push({ author: T('reg_bloc', { name: b.name, type: this.blocType(b.type), turn: b.turn }),
        text: T('reg_bloc_text', { members: b.members.map((m) => this.name(m)).join(', '), goal: b.goal }), kind: 'leader' });
    }
    const act = this.activeTreaties();
    items.push({ author: `[COLOR_LIGHTBLUE]${T('reg_active')}[ENDCOLOR]`, text: act.length ? '' : T('reg_none'), kind: 'header' });
    for (const t of act.slice(-25).reverse()) {
      items.push({ author: T('reg_treaty', { title: t.title, kind: this.kindName(t.kind) }),
        text: T('reg_treaty_text', { parties: t.parties.map((x) => this.name(x)).join(' — '), turn: t.turn, expires: t.expires, summary: t.summary }), kind: 'leader' });
    }
    const old = this.d.treaties.filter((t) => t.status !== 'active').slice(-10).reverse();
    if (old.length) {
      items.push({ author: `[COLOR_LIGHTBLUE]${T('reg_old')}[ENDCOLOR]`, text: '', kind: 'header' });
      for (const t of old) {
        items.push({ author: `[COLOR_Grey]${this.q(t.title)}[ENDCOLOR]`,
          text: t.status === 'broken' ? `[COLOR_RED]${T('reg_broken', { who: this.name(t.brokenBy), turn: t.brokenTurn })}[ENDCOLOR]`
            : t.status === 'terminated' ? T('reg_terminated', { who: this.name(t.endedBy), turn: t.endedTurn }) : T('reg_expired', { turn: t.expires }), kind: 'system' });
      }
    }
    return items;
  }

  // Строка «договоры с вами» для шапки чата каждого лидера: { "<id>": "Договоры с вами: …" }
  treatyInfo() {
    const human = this.brain.human();
    if (!human) return {};
    const out = {};
    for (const p of this.snap?.players || []) {
      if (p.human) continue;
      const list = this.treatiesBetween(human.id, p.id).map((t) =>
        this.t('tinfo_item', { kind: this.kindName(t.kind), title: cut(t.title, 60), expires: t.expires }));
      for (const bl of this.blocsOf(human.id)) if (bl.members.includes(p.id)) list.push(this.t('tinfo_bloc', { name: cut(bl.name, 40) }));
      if (list.length) {
        out[String(p.id)] = this.t('tinfo', { list: list.slice(0, 4).join(' · '), more: list.length > 4 ? list.length - 4 : 0 });
      }
    }
    return out;
  }

  async sendTreaties() {
    await this.game.deliver({ type: 'treaty_info', info: this.treatyInfo() }).catch(() => {});
    const items = this.renderTreaties();
    await this.game.deliver({ type: 'feed', feed: 'treaties', reset: true }).catch(() => {});
    await this.game.deliverChunked({ type: 'feed', feed: 'treaties' }, 'items', items).catch(() => {});
  }

  // Восстановить хронику и реестр в UI (после загрузки сейва / перезапуска моста)
  async restore() {
    await this.game.deliver({ type: 'feed', feed: 'world', reset: true });
    for (const e of this.d.chronicle.slice(-(this.cfg.restore_entries ?? 12))) await this.sendEntry(e, false);
    await this.sendTreaties();
  }
}

// Обрезать по границе слова
function cut(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const i = s.lastIndexOf(' ', n - 1);
  return s.slice(0, i > n * 0.6 ? i : n - 1).replace(/[\s,;:.—-]+$/, '') + '…';
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
