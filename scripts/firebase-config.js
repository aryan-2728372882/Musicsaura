// scripts/firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  deleteUser,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyClIhXAaTVmlqhEPxU49C9w9fDkUag-1eQ",
  authDomain: "vibe-tunes.firebaseapp.com",
  databaseURL: "https://vibe-tunes-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "vibe-tunes",
  storageBucket: "vibe-tunes.firebasestorage.app",
  messagingSenderId: "792892627539",
  appId: "1:792892627539:web:69817da08d2d4741a404a6",
  measurementId: "G-7RQD85KP8Z"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Use the modular GoogleAuthProvider
const provider = new GoogleAuthProvider();

export {
  auth,
  db,
  provider,
  onAuthStateChanged,
  signOut,
  deleteUser,
  reauthenticateWithPopup,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  increment,
  serverTimestamp
};
