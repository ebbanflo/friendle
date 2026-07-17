import { CODE_ALPHABET, CODE_LEN } from './config.js';

export const qs = new URLSearchParams(location.search);

export function makeCode() {
  let c = '';
  const buf = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return c;
}

export function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

export function makeId() {
  return 'p' + Math.random().toString(36).slice(2, 10);
}

// Per-tab identity survives reloads (drop-in resilience) but not new tabs.
export function tabId() {
  let id = sessionStorage.getItem('friendle-id');
  if (!id) { id = makeId(); sessionStorage.setItem('friendle-id', id); }
  return id;
}

export function rand(n) { return Math.floor(Math.random() * n); }
export function pick(arr) { return arr[rand(arr.length)]; }

export const now = () => Date.now();

// Light obfuscation for the FRIEND-mode secret in transit (broadcast channels
// are public; this keeps the word out of casual network-tab plaintext - it is
// NOT cryptography, see INSTRUCTIONS.md).
export function obf(word, key) {
  const k = 'friendle❤' + key;
  let out = '';
  for (let i = 0; i < word.length; i++) {
    out += String.fromCharCode(word.charCodeAt(i) ^ k.charCodeAt(i % k.length));
  }
  return btoa(out);
}
export function deobf(s, key) {
  const k = 'friendle❤' + key;
  const raw = atob(s);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw.charCodeAt(i) ^ k.charCodeAt(i % k.length));
  }
  return out;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv); // custom props need setProperty
        else node.style[sk] = sv;
      }
    }
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export function shareLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('join', code);
  // keep local-transport rooms shareable between tabs in dev/tests
  if (qs.get('t') === 'local') url.searchParams.set('t', 'local');
  return url.toString();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
