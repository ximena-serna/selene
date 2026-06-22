import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBWfvJ5oKQwgvNaKXa3YRhT8KEtV8zQDCM",
  authDomain: "control-ahorros-fb.firebaseapp.com",
  projectId: "control-ahorros-fb",
  storageBucket: "control-ahorros-fb.firebasestorage.app",
  messagingSenderId: "378589612511",
  appId: "1:378589612511:web:80c46153d7457b1199dc6a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp, Timestamp
};
