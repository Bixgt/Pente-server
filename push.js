/* Avisos push (Web Push) de Pente.
 * Guarda de cada aparato un «dónde avisarle» (suscripción del navegador) y manda avisos cuando algo le pasa a esa cuenta
 * (te invitan a un torneo, te retan, te mandan una solicitud de amistad, revisaron tu comentario).
 * Si falta la librería web-push o las claves (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY), queda apagado y el servidor funciona igual.
 * Tabla en Supabase: push_subs (ver sql/supabase/push.sql). Sin Supabase, las suscripciones quedan en memoria (para probar). */
'use strict';

const KINDS = ['invite', 'tourney', 'friend', 'feedback'];            // tipos de aviso que cada persona puede prender o apagar

function makePush({ env, sbUrl, sbService, svcHeaders, fetchImpl, webpush }) {
  env = env || process.env;
  const pub = String(env.VAPID_PUBLIC_KEY || '').trim(), priv = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || 'mailto:admin@example.com').trim();
  let wp = webpush || null;
  if (!wp) { try { wp = require('web-push'); } catch (e) { wp = null; } }
  const enabled = !!(wp && pub && priv);
  if (enabled) { try { wp.setVapidDetails(subject, pub, priv); } catch (e) { return disabled('claves inválidas: ' + e.message); } }
  else return disabled(!wp ? 'falta la librería web-push' : 'faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const useDb = !!(sbUrl && sbService && doFetch);
  const mem = new Map();                                              // endpoint -> fila (sin Supabase)
  const H = (x) => svcHeaders(Object.assign({ 'Content-Type': 'application/json' }, x));
  const T = '/rest/v1/push_subs', q = encodeURIComponent;

  const cleanPrefs = (p) => { const o = {}; p = p && typeof p === 'object' ? p : {}; KINDS.forEach((k) => { o[k] = p[k] !== false; }); return o; };
  const okSub = (s) => !!s && typeof s.endpoint === 'string' && /^https:\/\/[^\s]{10,900}$/.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;

  async function save(uid, sub, prefs, ua) {
    if (!okSub(sub)) return false;
    const row = { uid, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, prefs: cleanPrefs(prefs), ua: String(ua || '').slice(0, 200) };
    if (!useDb) { mem.set(row.endpoint, row); return true; }
    const r = await doFetch(sbUrl + T + '?on_conflict=endpoint', { method: 'POST', headers: H({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row) });
    return r.ok;
  }
  async function remove(uid, endpoint) {
    if (!useDb) { const r = mem.get(endpoint); if (r && r.uid === uid) mem.delete(endpoint); return true; }
    const r = await doFetch(sbUrl + T + '?endpoint=eq.' + q(endpoint) + '&uid=eq.' + q(uid), { method: 'DELETE', headers: H() });
    return r.ok;
  }
  async function setPrefs(uid, endpoint, prefs) {
    if (!useDb) { const r = mem.get(endpoint); if (r && r.uid === uid) r.prefs = cleanPrefs(prefs); return true; }
    const r = await doFetch(sbUrl + T + '?endpoint=eq.' + q(endpoint) + '&uid=eq.' + q(uid), { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify({ prefs: cleanPrefs(prefs) }) });
    return r.ok;
  }
  async function listFor(uid) {
    if (!useDb) return [...mem.values()].filter((r) => r.uid === uid);
    const r = await doFetch(sbUrl + T + '?uid=eq.' + q(uid) + '&select=endpoint,p256dh,auth,prefs&limit=10', { headers: H() });
    if (!r.ok) return []; return r.json();
  }
  async function dropEndpoint(endpoint) {
    if (!useDb) { mem.delete(endpoint); return; }
    try { await doFetch(sbUrl + T + '?endpoint=eq.' + q(endpoint), { method: 'DELETE', headers: H() }); } catch (e) {}
  }
  /* kind: uno de KINDS · payload: { title, body, url, tag } · devuelve cuántos avisos salieron */
  async function send(uid, kind, payload) {
    if (!uid || KINDS.indexOf(kind) < 0) return 0;
    let subs = []; try { subs = await listFor(uid); } catch (e) { return 0; }
    const body = JSON.stringify({ title: String(payload.title || 'Pente').slice(0, 80), body: String(payload.body || '').slice(0, 200), url: String(payload.url || './').slice(0, 300), tag: String(payload.tag || kind).slice(0, 60), kind });
    let n = 0;
    await Promise.all(subs.filter((s) => cleanPrefs(s.prefs)[kind]).map(async (s) => {
      try { await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: 'high' }); n++; }      // 'high' despierta al celu aunque esté en ahorro de batería (Doze); con 'normal' Android puede demorar el aviso
      catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await dropEndpoint(s.endpoint);
        else console.log('[push] falló un envío (' + String(e && (e.statusCode || e.code || e.message)).slice(0, 60) + ') · ' + kind);
      }
    }));
    return n;
  }
  return { enabled: true, publicKey: pub, kinds: KINDS, save, remove, setPrefs, send, cleanPrefs, why: '' };
}
function disabled(why) {
  const no = async () => false;
  return { enabled: false, publicKey: '', kinds: KINDS, save: no, remove: no, setPrefs: no, send: async () => 0, cleanPrefs: (p) => p, why };
}
module.exports = { makePush, KINDS };
