// scripts/firebase-config.js — MusicsAura 3.0 (Offline-Resilient Local Module Architecture)
import { initializeApp } from "./firebase/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
  deleteUser,
  reauthenticateWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile
} from "./firebase/firebase-auth.js";
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
  where,
  orderBy,
  limit,
  getDocs,
  addDoc,
  writeBatch
} from "./firebase/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyClIhXAaTVmlqhEPxU49C9w9fDkUag-1eQ",
  authDomain: "vibe-tunes.firebaseapp.com",
  projectId: "vibe-tunes",
  storageBucket: "vibe-tunes.appspot.com",
  messagingSenderId: "367351659914",
  appId: "1:367351659914:web:0ba054f0a2ca7b686d0b67",
  measurementId: "G-GZ0L6GNDCP"
};

// Admin emails — single source of truth
export const ADMIN_EMAILS = ["prabhakararyan2007@gmail.com"];
export const isAdmin = (email) => !!email && ADMIN_EMAILS.includes(email.toLowerCase().trim());

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
export const provider = new GoogleAuthProvider();

export {
  // Auth
  signInWithPopup, onAuthStateChanged, signOut, deleteUser, reauthenticateWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  // Firestore (Metadata only: song names, links, artists, genres, users)
  doc, getDoc, setDoc, onSnapshot, updateDoc, deleteDoc,
  increment, serverTimestamp, collection, query, where, orderBy, limit, getDocs, addDoc, writeBatch
};
