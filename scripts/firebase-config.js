// scripts/firebase-config.js — MusicsAura
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  deleteUser,
  reauthenticateWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  increment,
  serverTimestamp,
  collection,
  query,
  orderBy,
  getDocs
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

// Admin emails — single source of truth
export const ADMIN_EMAILS = ["prabhakararyan2007@gmail.com"];
export const isAdmin = (email) => ADMIN_EMAILS.includes(email?.toLowerCase());

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
export const provider = new GoogleAuthProvider();

export {
  onAuthStateChanged, signOut, deleteUser, reauthenticateWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  doc, getDoc, setDoc, onSnapshot, updateDoc, deleteDoc,
  increment, serverTimestamp, collection, query, orderBy, getDocs
};
