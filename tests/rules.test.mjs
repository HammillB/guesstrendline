// Firestore rules tests for the class-size cap. Needs Java and:
//   npm i firebase-tools @firebase/rules-unit-testing firebase
//   npx firebase emulators:exec --only firestore --project demo-fit "node tests/rules.test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import fs from 'fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-fit',
  firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 }
});
const inc = (n) => firebase.firestore.FieldValue.increment(n);
const ts = (ms) => firebase.firestore.Timestamp.fromMillis(ms);
const now = Date.now();
const host = env.authenticatedContext('host').firestore();
const classData = { hostUid: 'host', level: 'easy', rounds: 10, seed: 1, status: 'lobby', phase: 'lobby', round: 0, board: [], createdAt: now, expiresAt: ts(now + 864e5) };
const player = (uid) => ({ name: 'S' + uid, joinedAt: now, lines: {}, expiresAt: ts(now + 864e5) });

let pass = 0, fail = 0;
const check = async (label, p, ok) => {
  try { await (ok ? assertSucceeds(p) : assertFails(p)); pass++; console.log('ok  ', label); }
  catch (e) { fail++; console.log('FAIL', label, String(e.message).slice(0, 140)); }
};
const createClass = (db, code, count = 0) => { const b = db.batch();
  b.set(db.doc('classes/' + code), classData); b.set(db.doc(`classes/${code}/meta/roster`), { count, expiresAt: ts(now + 864e5) }); return b.commit(); };
const join = (code, uid, by = 1) => { const db = env.authenticatedContext(uid).firestore(); const b = db.batch();
  b.set(db.doc(`classes/${code}/players/${uid}`), player(uid)); b.update(db.doc(`classes/${code}/meta/roster`), { count: inc(by) }); return b.commit(); };

await check('host creates class with roster', createClass(host, 'ABCD'), true);
for (let i = 1; i <= 30; i++) await check('student ' + i + ' joins', join('ABCD', 'u' + i), true);
await check('31st student refused', join('ABCD', 'u31'), false);
await check('plain player create (no count bump) refused when a roster exists',
  env.authenticatedContext('u32').firestore().doc('classes/ABCD/players/u32').set(player('u32')), false);
{ const b = host.batch(); b.delete(host.doc('classes/ABCD/players/u1')); b.update(host.doc('classes/ABCD/meta/roster'), { count: inc(-1) });
  await check('host kicks u1 and frees the seat', b.commit(), true); }
await check('new student takes the freed seat', join('ABCD', 'u31'), true);
await check('then full again', join('ABCD', 'u33'), false);

await check('host creates class 2', createClass(host, 'EFGH'), true);
await check('join bumping count by 2 refused', join('EFGH', 't1', 2), false);
await check('student bumps count with no player doc refused',
  env.authenticatedContext('t2').firestore().doc('classes/EFGH/meta/roster').update({ count: inc(1) }), false);
await check('student edits the class document refused',
  env.authenticatedContext('t2').firestore().doc('classes/EFGH').update({ phase: 'done' }), false);
await check('student cannot lower the count',
  env.authenticatedContext('t2').firestore().doc('classes/EFGH/meta/roster').update({ count: inc(-1) }), false);
await check('student cannot create a roster',
  env.authenticatedContext('t3').firestore().doc('classes/WXYZ/meta/roster').set({ count: 0, expiresAt: ts(now + 864e5) }), false);
await check('host cannot start a roster above zero', createClass(host, 'IJKL', 5), false);
await check('joins do not touch the class document', (async () => {
  const snap = await host.doc('classes/ABCD').get();
  if ('playerCount' in snap.data()) throw new Error('class doc has playerCount');
})(), true);

// Classes made before the roster existed are uncapped but still work.
await env.withSecurityRulesDisabled(async (c) => { await c.firestore().doc('classes/MNOP').set(classData); });
await check('plain join into a class with no roster works',
  env.authenticatedContext('l1').firestore().doc('classes/MNOP/players/l1').set(player('l1')), true);

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
