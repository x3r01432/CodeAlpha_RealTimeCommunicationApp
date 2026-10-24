// End-to-end encryption helpers for chat (and file metadata).
// The key is derived in the browser from a room passphrase with PBKDF2 and never sent to the server.
(function (root) {
  const subtle = (root.crypto || globalThis.crypto).subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveKey(passphrase, roomId) {
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('meetup:' + roomId), iterations: 150000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, text) {
    const iv = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function decrypt(key, { iv, ct }) {
    return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
  }
  const api = { deriveKey, encrypt, decrypt };
  if (typeof module !== 'undefined') module.exports = api; else root.E2E = api;
})(typeof window !== 'undefined' ? window : globalThis);
