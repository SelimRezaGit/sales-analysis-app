/* tracker.js - Firebase login, location tracking, activity logging, admin panel */

let db = null;
let currentUser = null;
let locationInterval = null;
let adminMapInstance = null;
let adminMarkers = {};
let usersUnsubscribe = null;
let activitiesUnsubscribe = null;

const LOCATION_INTERVAL_MS = 60 * 1000;

// ── INIT ──────────────────────────────────────────────────────────────────────
async function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    return true;
  } catch(e) { console.error('Firebase init:', e); return false; }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function loginUser(empId, name) {
  if (!db) { const ok = await initFirebase(); if (!ok) throw new Error('Firebase init failed'); }

  const id = empId.trim().toUpperCase();
  const isAdmin = (id === ADMIN_EMP_ID);
  currentUser = { empId: id, name: name.trim(), isAdmin };
  localStorage.setItem('ipl_user', JSON.stringify(currentUser));

  await db.collection('users').doc(id).set({
    empId: id, name: name.trim(), isAdmin,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    status: 'online'
  }, { merge: true });

  logActivity('login', { name: name.trim() });
  startLocationTracking();
  return currentUser;
}

async function logoutUser() {
  stopLocationTracking();
  if (db && currentUser) {
    await db.collection('users').doc(currentUser.empId)
      .update({ status: 'offline', lastSeen: firebase.firestore.FieldValue.serverTimestamp() })
      .catch(() => {});
    logActivity('logout', {});
  }
  localStorage.removeItem('ipl_user');
  currentUser = null;
}

// ── LOCATION ──────────────────────────────────────────────────────────────────
function startLocationTracking() {
  if (!navigator.geolocation) return;
  sendLocation();
  locationInterval = setInterval(sendLocation, LOCATION_INTERVAL_MS);
}

function stopLocationTracking() {
  if (locationInterval) { clearInterval(locationInterval); locationInterval = null; }
}

function sendLocation() {
  navigator.geolocation.getCurrentPosition(
    pos => pushLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    err => console.warn('Location:', err.message),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

async function pushLocation(lat, lng, accuracy) {
  if (!db || !currentUser) return;
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('users').doc(currentUser.empId).update({
    location: { lat, lng, accuracy }, locationUpdatedAt: now, lastSeen: now, status: 'online'
  }).catch(() => {});
  await db.collection('locations').add({
    empId: currentUser.empId, name: currentUser.name, lat, lng, accuracy, timestamp: now
  }).catch(() => {});
}

// ── ACTIVITY ──────────────────────────────────────────────────────────────────
async function logActivity(type, data) {
  if (!db || !currentUser) return;
  await db.collection('activities').add({
    empId: currentUser.empId, name: currentUser.name,
    type, data, timestamp: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(() => {});
}

function trackReportView(group, terrId) { logActivity('view_report', { group, terrId }); }
function trackSearchView(group, terrId, products) { logActivity('view_search', { group, terrId, products }); }
function trackDownload(group, terrId, type) { logActivity('download', { group, terrId, type }); }

// ── ADMIN MAP ─────────────────────────────────────────────────────────────────
function initAdminPanel() {
  subscribeToUsers();
  subscribeToActivities();
  loadLeaflet();
}

function loadLeaflet() {
  if (!document.getElementById('leaflet-css')) {
    const l = document.createElement('link');
    l.id = 'leaflet-css'; l.rel = 'stylesheet';
    l.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
    document.head.appendChild(l);
  }
  if (typeof L === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => setTimeout(createMap, 300);
    document.head.appendChild(s);
  } else {
    setTimeout(createMap, 300);
  }
}

function createMap() {
  if (adminMapInstance || !document.getElementById('adminMap')) return;
  adminMapInstance = L.map('adminMap').setView([23.8103, 90.4125], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(adminMapInstance);
}

function subscribeToUsers() {
  if (!db) return;
  if (usersUnsubscribe) usersUnsubscribe();
  usersUnsubscribe = db.collection('users').onSnapshot(snap => {
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateStats(users);
    updateUsersList(users);
    updateMapMarkers(users);
  }, e => console.error('users snap:', e));
}

function subscribeToActivities() {
  if (!db) return;
  if (activitiesUnsubscribe) activitiesUnsubscribe();
  activitiesUnsubscribe = db.collection('activities')
    .orderBy('timestamp', 'desc').limit(60)
    .onSnapshot(snap => {
      updateActivityFeed(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, e => console.error('activities snap:', e));
}

function updateStats(users) {
  const online = users.filter(u => u.status === 'online' && !u.isAdmin).length;
  const total  = users.filter(u => !u.isAdmin).length;
  const el = document.getElementById('adminStats');
  if (el) el.innerHTML = `
    <span class="stat-chip green">🟢 Online: ${online}</span>
    <span class="stat-chip blue">👤 Total: ${total}</span>
    <span class="stat-chip gray">🔄 Live</span>`;
}

function updateUsersList(users) {
  const el = document.getElementById('onlineUsers');
  if (!el) return;
  const nonAdmin = users.filter(u => !u.isAdmin);
  const online  = nonAdmin.filter(u => u.status === 'online');
  const offline = nonAdmin.filter(u => u.status !== 'online');

  const card = u => {
    const ts  = u.lastSeen?.toDate ? timeAgo(u.lastSeen.toDate()) : '—';
    const loc = u.location ? `📍 ${u.location.lat.toFixed(4)}, ${u.location.lng.toFixed(4)}` : '📍 No location yet';
    return `<div class="user-card ${u.status === 'online' ? 'online' : 'offline'}">
      <div class="user-info">
        <span class="user-dot ${u.status === 'online' ? 'online' : ''}"></span>
        <strong>${escHtml(u.name)}</strong>
        <code>${escHtml(u.empId)}</code>
      </div>
      <div class="user-meta">${loc}</div>
      <div class="user-meta">Last seen: ${ts}</div>
    </div>`;
  };

  el.innerHTML =
    (online.length  ? online.map(card).join('')  : '<p class="no-data">কেউ online নেই</p>') +
    (offline.length ? `<p class="offline-label">Offline (${offline.length})</p>${offline.map(card).join('')}` : '');
}

function updateMapMarkers(users) {
  if (!adminMapInstance) return;
  const bounds = [];
  users.forEach(u => {
    if (!u.location || u.isAdmin) return;
    const { lat, lng } = u.location;
    const color = u.status === 'online' ? '#27ae60' : '#95a5a6';
    const shortName = u.name.split(' ')[0].substring(0, 6);
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:${color};color:#fff;border:2.5px solid #fff;border-radius:50%;width:38px;height:38px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,.35);text-align:center;line-height:1.2;">${escHtml(shortName)}</div>`,
      iconSize: [38, 38], iconAnchor: [19, 19]
    });
    const ts = u.locationUpdatedAt?.toDate ? timeAgo(u.locationUpdatedAt.toDate()) : '—';
    const popup = `<b>${escHtml(u.name)}</b><br>ID: ${escHtml(u.empId)}<br>Updated: ${ts}<br>Status: ${u.status}`;
    if (adminMarkers[u.empId]) {
      adminMarkers[u.empId].setLatLng([lat, lng]).setIcon(icon).setPopupContent(popup);
    } else {
      adminMarkers[u.empId] = L.marker([lat, lng], { icon })
        .addTo(adminMapInstance).bindPopup(popup);
    }
    bounds.push([lat, lng]);
  });
  if (bounds.length > 0) {
    try { adminMapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 }); } catch(e) {}
  }
}

function updateActivityFeed(acts) {
  const el = document.getElementById('activityFeed');
  if (!el) return;
  if (!acts.length) { el.innerHTML = '<p class="no-data">কোনো activity নেই</p>'; return; }
  const icons = { login:'🟢', logout:'🔴', view_report:'📊', view_search:'🔍', download:'⬇' };
  el.innerHTML = acts.map(a => {
    const ts = a.timestamp?.toDate ? timeAgo(a.timestamp.toDate()) : '—';
    const icon = icons[a.type] || '•';
    let detail = '';
    if (a.type === 'view_report') detail = `${a.data?.group||''} › ${a.data?.terrId||''}`;
    if (a.type === 'view_search') detail = `${a.data?.terrId||''}: ${(a.data?.products||[]).join(', ')}`;
    if (a.type === 'download')   detail = `${a.data?.terrId||''} (${a.data?.type||''})`;
    return `<div class="activity-item">
      <span class="act-icon">${icon}</span>
      <div class="act-body">
        <strong>${escHtml(a.name)}</strong>
        <span class="act-type">${a.type.replace(/_/g,' ')}</span>
        ${detail ? `<span class="act-detail">${escHtml(detail)}</span>` : ''}
      </div>
      <span class="act-time">${ts}</span>
    </div>`;
  }).join('');
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return date.toLocaleDateString('en-GB');
}

function escHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
