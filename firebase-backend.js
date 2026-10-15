// Online class backend for Fit the Line (Firebase, free Spark plan).
// Loaded as an ES module by index.html. If it fails to load, the game falls back to practice mode.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, updateDoc, deleteDoc, getDocs,
  writeBatch, increment, onSnapshot, Timestamp
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// These values are public by design. Security comes from firestore.rules, not from hiding them.
const app = initializeApp({
  apiKey: 'AIzaSyBkRtayjaZz4wdD6nhlxSBwQxxXPpw4jTo',
  authDomain: 'trendlinegame.firebaseapp.com',
  projectId: 'trendlinegame',
  storageBucket: 'trendlinegame.firebasestorage.app',
  messagingSenderId: '590140460183',
  appId: '1:590140460183:web:b553dedc26428e3c676dd2'
});
const auth = getAuth(app);
// School networks often block WebSockets; let the SDK fall back to long polling.
// A persistent local cache lets a refreshed page resume its listeners and be billed only for
// documents that changed in the meantime (within about 30 minutes), instead of re-reading all of them.
// If the browser blocks IndexedDB (some private modes), fall back to the default in-memory cache.
let db;
try {
  db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
}

// Keep in sync with the 30 in firestore.rules, which is what actually enforces the cap.
const MAX_PLAYERS = 30;

const classRef = (code) => doc(db, 'classes', code);
const playerRef = (code, uid) => doc(db, 'classes', code, 'players', uid);

function ready() {
  return new Promise((res) => {
    const off = onAuthStateChanged(auth, (u) => { off(); res(u); });
  });
}

const api = {
  mode: 'online',

  async signInAnonymous() {
    let u = await ready();
    if (!u) u = (await signInAnonymously(auth)).user;
    return { uid: u.uid };
  },

  // Anyone can host a class: a teacher is just a signed-in (anonymous) browser.
  async signInTeacher() { return api.signInAnonymous(); },
  async currentTeacher() { return api.signInAnonymous(); },

  // expiresAt is stored as a real timestamp so a Firestore TTL policy can clean up old classes.
  async createClass(code, data) {
    await setDoc(classRef(code), { ...data, playerCount: 0, expiresAt: Timestamp.fromMillis(data.expiresAt) });
  },

  async getClass(code) {
    const s = await getDoc(classRef(code));
    return s.exists() ? s.data() : null;
  },

  watchClass(code, cb, onError) {
    return onSnapshot(classRef(code), (s) => cb(s.exists() ? s.data() : null), onError);
  },

  async updateClass(code, patch) {
    await updateDoc(classRef(code), patch);
  },

  async joinClass(code, uid, name) {
    const ref = playerRef(code, uid);
    const s = await getDoc(ref);
    if (s.exists()) return s.data();
    const now = Date.now();
    const p = { name, joinedAt: now, lines: {}, expiresAt: Timestamp.fromMillis(now + 24 * 3600 * 1000) };
    // Creating the player and bumping the class head count must happen together: the security
    // rules refuse the join unless both are in one batch and the count is still under the cap.
    const batch = writeBatch(db);
    batch.set(ref, p);
    batch.update(classRef(code), { playerCount: increment(1) });
    try {
      await batch.commit();
    } catch (e) {
      const again = await getDoc(ref).catch(() => null);        // joined a moment ago from this device
      if (again && again.exists()) return again.data();
      const c = await getDoc(classRef(code)).catch(() => null);
      if (c && c.exists() && (c.data().playerCount || 0) >= MAX_PLAYERS) {
        const full = new Error('This class is full (' + MAX_PLAYERS + ' students). Ask your teacher.');
        full.fit = true;
        throw full;
      }
      // Rules published before the class-size cap refuse the head-count update, but still accept a
      // plain join. This keeps joining working in the gap between deploying the page and the rules.
      // Under the new rules this plain write is refused, so it cannot get around the cap.
      try { await setDoc(ref, p); return p; } catch (_) { /* fall through to the original error */ }
      throw e;
    }
    return p;
  },

  async getPlayer(code, uid) {
    const s = await getDoc(playerRef(code, uid));
    return s.exists() ? s.data() : null;
  },

  watchPlayers(code, cb, onError) {
    return onSnapshot(collection(db, 'classes', code, 'players'), (snap) => {
      cb(snap.docs.map((d) => ({ ...d.data(), uid: d.id })));
    }, onError);
  },

  async lockLine(code, uid, round, arr) {
    await updateDoc(playerRef(code, uid), { ['lines.r' + round]: arr });
  },

  async kick(code, uid) {
    // Free the seat so someone else can join.
    const batch = writeBatch(db);
    batch.delete(playerRef(code, uid));
    batch.update(classRef(code), { playerCount: increment(-1) });
    await batch.commit();
  },

  async deleteClass(code) {
    const snap = await getDocs(collection(db, 'classes', code, 'players'));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(classRef(code));
  }
};

window.FitBackend = api;
window.dispatchEvent(new Event('fitbackend'));
