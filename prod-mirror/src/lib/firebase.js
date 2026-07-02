// Firebase init — reuses the davismarginiq project per project brief.
// Firestore only; auth removed in v0.3.0 to match Glory Bound Dispatch / MarginIQ
// pattern (no login). The Firestore rule for customer_notes is open
// (`allow read, write: if true;`) so unauth'd writes from this client work.

import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = !!(cfg.apiKey && cfg.projectId);

export const app = firebaseConfigured ? initializeApp(cfg) : null;
// VITE_FIRESTORE_DATABASE selects a NAMED Firestore database (the UAT prod-mirror
// sets uat-mirror so client-side writes — customer_notes etc. — never touch the
// production default database). Unset = the default database, unchanged.
const dbName = (import.meta.env.VITE_FIRESTORE_DATABASE || '').trim();
export const db = app ? (dbName ? getFirestore(app, dbName) : getFirestore(app)) : null;
