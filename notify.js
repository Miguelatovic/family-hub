// notify.js — Ejecutado por GitHub Actions cada mañana a las 7:00
// Lee los eventos de hoy y esta semana desde Firebase y manda push a todos los dispositivos suscritos

const https = require('https');
const crypto = require('crypto');

// ── CONFIG (desde variables de entorno de GitHub Secrets) ──
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_SUBJECT = 'mailto:m.rodriguezmerino@gmail.com';
const FIREBASE_PROJECT = 'family-hub-65434';
const FIREBASE_API_KEY  = 'AIzaSyBzXbk5pxVTnHreNraV0HzVEpOm1ZycZdw';

// ── UTILIDADES ──
function b64url(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function dateStr(d) {
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// Días y meses en español
const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// ── PETICIÓN HTTPS ──
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── OBTENER TOKEN DE FIREBASE (acceso anónimo para leer Firestore) ──
async function getFirebaseToken() {
  const body = JSON.stringify({ returnSecureToken: true });
  const res = await request({
    hostname: 'identitytoolkit.googleapis.com',
    path: `/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  return res.body.idToken;
}

// ── LEER COLECCIÓN DE FIRESTORE ──
async function firestoreRead(collection, token) {
  const res = await request({
    hostname: 'firestore.googleapis.com',
    path: `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}?pageSize=300`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.body.documents) return [];
  return res.body.documents.map(doc => {
    const id = doc.name.split('/').pop();
    const fields = doc.fields || {};
    const obj = { id };
    for (const [k, v] of Object.entries(fields)) {
      if (v.stringValue !== undefined) obj[k] = v.stringValue;
      else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
      else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
      else if (v.arrayValue !== undefined) obj[k] = (v.arrayValue.values||[]).map(x=>x.integerValue!==undefined?parseInt(x.integerValue):x.stringValue);
    }
    return obj;
  });
}

// ── EXPANDIR EVENTOS RECURRENTES ──
function expandRecurring(ev, viewStart, viewEnd) {
  if (!ev.recur || ev.recur === 'none') {
    if (ev.date >= viewStart && ev.date <= viewEnd) return [ev];
    return [];
  }
  const results = [];
  const start = new Date(ev.date + 'T12:00:00');
  const end = ev.recurEnd ? new Date(ev.recurEnd + 'T12:00:00') : new Date('2099-12-31');
  const vs = new Date(viewStart + 'T00:00:00');
  const ve = new Date(viewEnd + 'T23:59:59');
  let cur = new Date(start);
  let safety = 0;
  while (cur <= end && cur <= ve && safety < 500) {
    safety++;
    if (cur >= vs) results.push({ ...ev, date: dateStr(cur) });
    if (ev.recur === 'weekly') {
      if (ev.recurDays && ev.recurDays.length > 0) {
        let found = false;
        for (let d = 1; d <= 7; d++) {
          const next = new Date(cur); next.setDate(cur.getDate() + d);
          if (next > end || next > ve) break;
          if (ev.recurDays.includes(next.getDay())) { cur = next; found = true; break; }
        }
        if (!found) break;
      } else { cur.setDate(cur.getDate() + 7); }
    } else if (ev.recur === 'biweekly') { cur.setDate(cur.getDate() + 14); }
    else if (ev.recur === 'monthly') { cur.setMonth(cur.getMonth() + 1); }
    else if (ev.recur === 'yearly') { cur.setFullYear(cur.getFullYear() + 1); }
    else break;
  }
  return results;
}

// ── GENERAR TEXTO DE NOTIFICACIÓN ──
function buildNotification(events, today, weekEnd) {
  const todayEvs = events.filter(e => e.date === today);
  const weekEvs  = events.filter(e => e.date > today && e.date <= weekEnd);

  const todayStr_display = (() => {
    const d = new Date(today + 'T12:00:00');
    return `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
  })();

  let title = `📅 FamilyHub — ${todayStr_display}`;
  let body = '';

  if (todayEvs.length === 0) {
    body = '✨ Hoy no tienes eventos. ';
  } else {
    const items = todayEvs.map(e => e.time ? `${e.desc} (${e.time})` : e.desc).join(' · ');
    body = `Hoy: ${items}. `;
  }

  if (weekEvs.length > 0) {
    const items = weekEvs.slice(0, 3).map(e => {
      const d = new Date(e.date + 'T12:00:00');
      return `${e.desc} (${DIAS[d.getDay()].slice(0,3)})`;
    }).join(' · ');
    body += `Esta semana: ${items}`;
  }

  return { title, body: body.trim() };
}

// ── ENVIAR WEB PUSH (manual, sin librería) ──
async function sendWebPush(subscription, payload) {
  // Parse keys
  const audience = new URL(subscription.endpoint).origin;
  const payloadBuf = Buffer.from(JSON.stringify(payload));

  // Build VAPID JWT
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: now + 12 * 3600,
    sub: VAPID_SUBJECT
  })));
  const signingInput = `${header}.${claims}`;

  // Sign with private key
  const privateKeyBytes = Buffer.from(VAPID_PRIVATE, 'base64');
  const keyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
      privateKeyBytes
    ]),
    format: 'der',
    type: 'pkcs8'
  });
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${b64url(sig)}`;

  const url = new URL(subscription.endpoint);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payloadBuf.length,
      'TTL': '86400',
      'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`
    }
  };

  try {
    const res = await request(options, payloadBuf);
    console.log(`Push enviado: ${res.status} → ${subscription.endpoint.slice(0,50)}...`);
    return res.status;
  } catch(e) {
    console.error('Error enviando push:', e.message);
    return 500;
  }
}

// ── MAIN ──
async function main() {
  console.log('🔔 FamilyHub Notificaciones — ' + new Date().toISOString());

  try {
    const token = await getFirebaseToken();
    console.log('✅ Firebase token obtenido');

    // Leer suscripciones y eventos
    const [subscriptions, events] = await Promise.all([
      firestoreRead('pushSubscriptions', token),
      firestoreRead('events', token)
    ]);

    console.log(`📱 ${subscriptions.length} dispositivos suscritos`);
    console.log(`📅 ${events.length} eventos en base de datos`);

    if (subscriptions.length === 0) {
      console.log('⚠️ No hay dispositivos suscritos. Abre la app y acepta las notificaciones.');
      return;
    }

    // Calcular rango
    const today = dateStr(new Date());
    const weekEnd = dateStr(new Date(Date.now() + 7 * 864e5));

    // Expandir recurrentes
    const expanded = [];
    for (const ev of events) {
      expanded.push(...expandRecurring(ev, today, weekEnd));
    }
    expanded.sort((a,b) => a.date.localeCompare(b.date));

    const { title, body } = buildNotification(expanded, today, weekEnd);
    console.log(`📢 Notificación: "${title}" — "${body}"`);

    // Enviar a todos los dispositivos
    let ok = 0, fail = 0;
    for (const sub of subscriptions) {
      if (!sub.endpoint || !sub.p256dh || !sub.auth) continue;
      const status = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        { title, body, url: '/' }
      );
      if (status < 300) ok++;
      else fail++;
    }

    console.log(`✅ Enviadas: ${ok} | ❌ Fallidas: ${fail}`);

  } catch(e) {
    console.error('❌ Error en notify.js:', e);
    process.exit(1);
  }
}

main();
