/* PENTE · Clubes (v1, solo servidor).
 * Un club = nombre, emoji, código de invitación, líder, socios con rol y configuraciones guardadas.
 * Roles fijos: leader (uno) > officer > member. Hace falta cuenta (jwt de Supabase verificado por el servidor).
 * Mientras no se active para todos (config.clubsPublic / CLUBS_PUBLIC=1) solo lo ve la cuenta admin: ctx.enabledFor(uid).
 * Estado: todo el conjunto de clubes vive en memoria (es chico) y se escribe a ctx.store en cada cambio.
 *   store = { all(): Promise<club[]>, put(club), del(id) }
 * Mensajes de entrada (todos con jwt):  cstatus, clist, ccreate, cjoin, cview, cleave, ckick, crole, ctransfer, cpreset, cpresetdel, ccode, crename, cdelete
 * Respuestas: {t:'cstatus', enabled} {t:'clist', clubs} {t:'cview', club} {t:'cres', op, ok, reason?, id?}  y avisos {t:'cdirty', id} a los socios conectados. */
'use strict';
const crypto = require('crypto');
const MAX_MEMBERS = 100, MAX_PRESETS = 10, MAX_JOINED = 5, MAX_OWNED = 2, NAME_MAX = 24, PRESET_NAME_MAX = 24;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_LEN = 6;
const RANK = { member: 1, officer: 2, leader: 3 };

module.exports = function makeClubs(ctx) {
  const { send, dailyUid, names, enabledFor, presence, store, cleanOpts } = ctx, gamesOf = ctx.gamesOf || (() => []);
  const clubs = new Map(), byCode = new Map(), byMember = new Map();           // id -> club, código -> id, uid -> Set(id)
  let ready = false;
  const readyP = Promise.resolve(store.all()).then((list) => { (list || []).forEach(index); ready = true; }).catch((e) => { console.log('[clubs] no se pudo cargar:', e && e.message); ready = true; });

  function index(c) { if (!Array.isArray(c.chat)) c.chat = []; if (!Array.isArray(c.log)) c.log = []; clubs.set(c.id, c); byCode.set(c.code, c.id); Object.keys(c.members).forEach((u) => addMember(u, c.id)); }
  function addMember(u, id) { if (!byMember.has(u)) byMember.set(u, new Set()); byMember.get(u).add(id); }
  function dropMember(u, id) { const s = byMember.get(u); if (s) { s.delete(id); if (!s.size) byMember.delete(u); } }
  const CHAT_MAX = 50, LOG_MAX = 20, TEXT_MAX = 200;
  const addLog = (c, k, n) => { c.log.push({ k, n: cleanTxt(n, 40), at: Date.now() }); if (c.log.length > LOG_MAX) c.log.splice(0, c.log.length - LOG_MAX); };
  async function nameOf(c, uid) { const m = c.members[uid]; if (m && m.n) return m.n; const nm = await names([uid]).catch(() => ({})); const n = (nm[uid] && nm[uid].name) || 'Jugador'; if (m) m.n = n; return n; }
  const saveT = new Map();                                       // el chat se guarda como mucho una vez cada 2 s por club
  const saveSoon = (c) => { if (saveT.has(c.id)) return; saveT.set(c.id, setTimeout(() => { saveT.delete(c.id); if (clubs.has(c.id)) save(c); }, 2000)); };
  const save = (c) => Promise.resolve(store.put(c)).catch((e) => console.log('[clubs] put falló:', e && e.message));
  const rand = (n, alpha) => { let s = ''; for (let i = 0; i < n; i++) s += alpha[crypto.randomInt(alpha.length)]; return s; };
  function newCode() { for (let i = 0; i < 50; i++) { const c = rand(CODE_LEN, CODE_ALPHABET); if (!byCode.has(c)) return c; } return null; }
  const cleanTxt = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const cleanEmoji = (s) => { const a = Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim()); return a.slice(0, 2).join('') || '♟️'; };
  const live = (u) => [...(presence.get(u) || [])].filter((w) => w.readyState === 1);
  const roleOf = (c, u) => (c.members[u] ? c.members[u].role : null);
  const atLeast = (c, u, r) => !!roleOf(c, u) && RANK[roleOf(c, u)] >= RANK[r];
  const dirty = (c, except) => Object.keys(c.members).forEach((u) => { if (u !== except) live(u).forEach((w) => send(w, { t: 'cdirty', id: c.id })); });

  async function view(c, uid) {
    const uids = Object.keys(c.members), nm = await names(uids).catch(() => ({}));
    const list = uids.map((u) => { const ws = live(u); if (nm[u] && nm[u].name) c.members[u].n = nm[u].name; return { uid: u, name: (nm[u] && nm[u].name) || 'Jugador', avatar: (nm[u] && nm[u].avatar) || '', role: c.members[u].role, online: ws.length > 0, busy: ws.some((w) => !!w.room) }; })
      .sort((a, b) => (b.online - a.online) || (RANK[b.role] - RANK[a.role]) || a.name.localeCompare(b.name));
    return { id: c.id, me: uid, name: c.name, emoji: c.emoji, role: roleOf(c, uid), max: MAX_MEMBERS, code: atLeast(c, uid, 'officer') ? c.code : '', games: gamesOf(c.id), log: c.log.slice(-8).reverse(), members: list, presets: c.presets.map((p) => ({ id: p.id, name: p.name, opts: p.opts })) };
  }
  function summary(c, uid) { let on = 0; Object.keys(c.members).forEach((u) => { if (live(u).length) on++; }); return { id: c.id, name: c.name, emoji: c.emoji, role: roleOf(c, uid), n: Object.keys(c.members).length, online: on }; }

  const HANDLERS = {
    cstatus: async (ws, msg, uid) => send(ws, { t: 'cstatus', enabled: true }),
    clist: async (ws, msg, uid) => send(ws, { t: 'clist', clubs: [...(byMember.get(uid) || [])].map((id) => clubs.get(id)).filter(Boolean).map((c) => summary(c, uid)) }),
    ccreate: async (ws, msg, uid) => {
      const name = cleanTxt(msg.name, NAME_MAX); if (name.length < 3) return res(ws, 'ccreate', 'BAD_NAME');
      if ([...(byMember.get(uid) || [])].length >= MAX_JOINED) return res(ws, 'ccreate', 'TOO_MANY_JOINED');
      if ([...clubs.values()].filter((c) => c.leader === uid).length >= MAX_OWNED) return res(ws, 'ccreate', 'TOO_MANY_OWNED');
      const code = newCode(); if (!code) return res(ws, 'ccreate', 'FULL');
      const c = { id: crypto.randomBytes(8).toString('hex'), code, name, emoji: cleanEmoji(msg.emoji), leader: uid, created: Date.now(), members: {}, presets: [], chat: [], log: [] };
      c.members[uid] = { role: 'leader', at: Date.now() }; addLog(c, 'created', await nameOf(c, uid)); index(c); await save(c);
      res(ws, 'ccreate', null, c.id); send(ws, { t: 'cview', club: await view(c, uid) });
    },
    cjoin: async (ws, msg, uid) => {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), id = byCode.get(code), c = id && clubs.get(id);
      if (!c) return res(ws, 'cjoin', 'NO_CLUB');
      if (c.members[uid]) { res(ws, 'cjoin', null, c.id); return send(ws, { t: 'cview', club: await view(c, uid) }); }
      if (Object.keys(c.members).length >= MAX_MEMBERS) return res(ws, 'cjoin', 'CLUB_FULL');
      if ([...(byMember.get(uid) || [])].length >= MAX_JOINED) return res(ws, 'cjoin', 'TOO_MANY_JOINED');
      c.members[uid] = { role: 'member', at: Date.now() }; addMember(uid, c.id); addLog(c, 'join', await nameOf(c, uid)); await save(c);
      res(ws, 'cjoin', null, c.id); send(ws, { t: 'cview', club: await view(c, uid) }); dirty(c, uid);
    },
    cview: async (ws, msg, uid, c) => send(ws, { t: 'cview', club: await view(c, uid) }),
    cleave: async (ws, msg, uid, c) => {
      const n = Object.keys(c.members).length;
      if (roleOf(c, uid) === 'leader') { if (n > 1) return res(ws, 'cleave', 'LEADER_MUST_TRANSFER'); return remove(ws, c, uid, 'cleave'); }
      const who = await nameOf(c, uid); delete c.members[uid]; dropMember(uid, c.id); addLog(c, 'leave', who); await save(c); res(ws, 'cleave', null, c.id); dirty(c);
    },
    ckick: async (ws, msg, uid, c) => {
      const to = String(msg.uid || ''); if (!c.members[to] || to === uid) return res(ws, 'ckick', 'BAD_TARGET');
      if (!atLeast(c, uid, 'officer') || RANK[roleOf(c, to)] >= RANK[roleOf(c, uid)]) return res(ws, 'ckick', 'FORBIDDEN');
      const who = await nameOf(c, to); delete c.members[to]; dropMember(to, c.id); addLog(c, 'kick', who); await save(c); live(to).forEach((w) => send(w, { t: 'cdirty', id: c.id, kicked: true })); res(ws, 'ckick', null, c.id); dirty(c);
    },
    crole: async (ws, msg, uid, c) => {
      const to = String(msg.uid || ''), role = msg.role === 'officer' ? 'officer' : msg.role === 'member' ? 'member' : null;
      if (roleOf(c, uid) !== 'leader') return res(ws, 'crole', 'FORBIDDEN');
      if (!role || !c.members[to] || to === uid) return res(ws, 'crole', 'BAD_TARGET');
      c.members[to].role = role; await save(c); res(ws, 'crole', null, c.id); dirty(c);
    },
    ctransfer: async (ws, msg, uid, c) => {
      const to = String(msg.uid || ''); if (roleOf(c, uid) !== 'leader') return res(ws, 'ctransfer', 'FORBIDDEN');
      if (!c.members[to] || to === uid) return res(ws, 'ctransfer', 'BAD_TARGET');
      c.members[to].role = 'leader'; c.members[uid].role = 'officer'; c.leader = to; await save(c); res(ws, 'ctransfer', null, c.id); dirty(c);
    },
    cpreset: async (ws, msg, uid, c) => {
      if (!atLeast(c, uid, 'officer')) return res(ws, 'cpreset', 'FORBIDDEN');
      const name = cleanTxt(msg.name, PRESET_NAME_MAX); if (!name) return res(ws, 'cpreset', 'BAD_NAME');
      const opts = cleanOpts(Object.assign({}, msg.opts, { players: 2, ffa: false })); opts.size = [9, 13, 15, 19].includes(Number(msg.opts && msg.opts.size)) ? Number(msg.opts.size) : 19;
      const pid = typeof msg.pid === 'string' ? msg.pid : '', ex = pid && c.presets.find((p) => p.id === pid);
      if (ex) { ex.name = name; ex.opts = opts; }
      else { if (c.presets.length >= MAX_PRESETS) return res(ws, 'cpreset', 'TOO_MANY_PRESETS'); c.presets.push({ id: crypto.randomBytes(4).toString('hex'), name, opts }); }
      await save(c); res(ws, 'cpreset', null, c.id); dirty(c);
    },
    cpresetdel: async (ws, msg, uid, c) => {
      if (!atLeast(c, uid, 'officer')) return res(ws, 'cpresetdel', 'FORBIDDEN');
      const n = c.presets.length; c.presets = c.presets.filter((p) => p.id !== String(msg.pid || '')); if (c.presets.length === n) return res(ws, 'cpresetdel', 'BAD_TARGET');
      await save(c); res(ws, 'cpresetdel', null, c.id); dirty(c);
    },
    cchatlog: async (ws, msg, uid, c) => send(ws, { t: 'cchatlog', id: c.id, msgs: c.chat }),
    cchat: async (ws, msg, uid, c) => {
      const text = cleanTxt(msg.text, TEXT_MAX); if (!text) return;
      const now = Date.now(); if (now - (ws.lastChat || 0) < 600) return res(ws, 'cchat', 'RATE'); ws.lastChat = now;
      const m = { u: uid, n: await nameOf(c, uid), x: text, at: now };
      c.chat.push(m); if (c.chat.length > CHAT_MAX) c.chat.splice(0, c.chat.length - CHAT_MAX); saveSoon(c);
      Object.keys(c.members).forEach((u) => live(u).forEach((w) => send(w, { t: 'cchat', id: c.id, m })));
    },
    ccode: async (ws, msg, uid, c) => {
      if (!atLeast(c, uid, 'officer')) return res(ws, 'ccode', 'FORBIDDEN');
      const code = newCode(); if (!code) return res(ws, 'ccode', 'FULL');
      byCode.delete(c.code); c.code = code; byCode.set(code, c.id); await save(c); res(ws, 'ccode', null, c.id); dirty(c);
    },
    crename: async (ws, msg, uid, c) => {
      if (roleOf(c, uid) !== 'leader') return res(ws, 'crename', 'FORBIDDEN');
      const name = cleanTxt(msg.name, NAME_MAX); if (name.length < 3) return res(ws, 'crename', 'BAD_NAME');
      c.name = name; if (msg.emoji != null) c.emoji = cleanEmoji(msg.emoji); await save(c); res(ws, 'crename', null, c.id); dirty(c);
    },
    cdelete: async (ws, msg, uid, c) => {
      if (roleOf(c, uid) !== 'leader') return res(ws, 'cdelete', 'FORBIDDEN');
      await remove(ws, c, uid, 'cdelete');
    }
  };
  async function remove(ws, c, uid, op) {
    const mem = Object.keys(c.members); clubs.delete(c.id); byCode.delete(c.code); mem.forEach((u) => dropMember(u, c.id));
    await Promise.resolve(store.del(c.id)).catch((e) => console.log('[clubs] del falló:', e && e.message));
    mem.forEach((u) => { if (u !== uid) live(u).forEach((w) => send(w, { t: 'cdirty', id: c.id, kicked: true })); }); res(ws, op, null, c.id);
  }
  function res(ws, op, reason, id) { send(ws, reason ? { t: 'cres', op, ok: false, reason } : { t: 'cres', op, ok: true, id }); }
  const READS = new Set(['cstatus', 'clist', 'cview', 'cchatlog']);
  const NEEDS_CLUB = new Set(['cview', 'cchat', 'cchatlog', 'cleave', 'ckick', 'crole', 'ctransfer', 'cpreset', 'cpresetdel', 'ccode', 'crename', 'cdelete']);

  /* true si el mensaje era de clubes (lo atiende de forma asíncrona) */
  function handle(ws, msg) {
    const h = HANDLERS[msg.t]; if (!h) return false;
    if (!READS.has(msg.t)) { const now = Date.now(); if (now - (ws.lastClub || 0) < 250) { send(ws, { t: 'cres', op: msg.t, ok: false, reason: 'RATE' }); return true; } ws.lastClub = now; }   // las lecturas no se limitan (el cliente refresca solo)
    Promise.resolve(readyP).then(() => dailyUid(ws, msg.jwt)).then(async (uid) => {
      if (!uid) return msg.t === 'cstatus' ? send(ws, { t: 'cstatus', enabled: false }) : res(ws, msg.t, 'LOGIN');
      if (!(await enabledFor(uid))) return msg.t === 'cstatus' ? send(ws, { t: 'cstatus', enabled: false }) : res(ws, msg.t, 'DISABLED');
      let c = null;
      if (NEEDS_CLUB.has(msg.t)) { c = clubs.get(String(msg.id || '')); if (!c || !c.members[uid]) return res(ws, msg.t, 'NO_CLUB'); }
      await h(ws, msg, uid, c);
    }).catch((e) => { console.log('[clubs] error', msg.t, e && e.message); res(ws, msg.t, 'ERROR'); });
    return true;
  }
  /* Un socio se conectó o desconectó: avisa a los demás socios de sus clubes para que refresquen «conectados». */
  function onPresence(uid) { const ids = byMember.get(uid); if (!ids) return; ids.forEach((id) => { const c = clubs.get(id); if (c) dirty(c, uid); }); }
  /* ¿los dos son socios de ese club? (para poder retarse sin ser amigos) */
  const isMember = (id, u) => { const c = clubs.get(String(id || '')); return !!c && !!c.members[u]; };
  const touchClub = (id, gameNames) => { const c = clubs.get(String(id || '')); if (!c) return; if (gameNames) { addLog(c, 'game', gameNames); saveSoon(c); } dirty(c); };         // avisa a los socios conectados que cambió algo (p. ej. empezó una partida)
  const shareClub = (id, a, b) => { const c = clubs.get(String(id || '')); return !!c && !!c.members[a] && !!c.members[b] && a !== b; };
  return { handle, onPresence, shareClub, isMember, touchClub, ready: readyP, _clubs: clubs };
};
