// Online class backend for Fit the Line (Firebase, free Spark plan).
// Loaded as an ES module by index.html. If it fails to load, the game falls back to practice mode.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot
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
const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });

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

  // Teachers unlock with a shared passcode. The passcode is checked by the security rules,
  // which compare it to a document students cannot read (config/main).
  async signInTeacher(pass) {
    let u = await ready();
    if (!u) u = (await signInAnonymously(auth)).user;
    try {
      await setDoc(doc(db, 'teachers', u.uid), { pass });
    } catch (e) {
      if (e && e.code === 'permission-denied') { const err = new Error('bad passcode'); err.teacherPass = true; throw err; }
      throw e;
    }
    return { uid: u.uid };
  },

  async currentTeacher() {
    const u = await ready();
    if (!u) return null;
    try {
      const s = await getDoc(doc(db, 'teachers', u.uid));
      return s.exists() ? { uid: u.uid } : null;
    } catch (e) { return null; }
  },

  async createClass(code, data) {
    await setDoc(classRef(code), data);
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
    const p = { name, joinedAt: Date.now(), lines: {} };
    await setDoc(ref, p);
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
    await deleteDoc(playerRef(code, uid));
  },

  async deleteClass(code) {
    const snap = await getDocs(collection(db, 'classes', code, 'players'));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(classRef(code));
  }
};

window.FitBackend = api;
window.dispatchEvent(new Event('fitbackend'));
