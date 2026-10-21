import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export class SessionVault {
  #master = randomBytes(32); #records = new Map();
  constructor({ ttl = 30 * 60_000, max = 500 } = {}) { this.ttl = ttl; this.max = max; }
  put(id, secret) {
    this.prune();
    if (!this.#records.has(id) && this.#records.size >= this.max) throw new Error('Vault full');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#master, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    this.#records.set(id, { iv, ciphertext, tag: cipher.getAuthTag(), expires: Date.now() + this.ttl });
  }
  get(id) {
    const r = this.#records.get(id);
    if (!r || r.expires <= Date.now()) { this.delete(id); return null; }
    const d = createDecipheriv('aes-256-gcm', this.#master, r.iv); d.setAAD(Buffer.from(id)); d.setAuthTag(r.tag);
    return Buffer.concat([d.update(r.ciphertext), d.final()]).toString('utf8');
  }
  delete(id) { const r = this.#records.get(id); if (r) r.ciphertext.fill(0); this.#records.delete(id); }
  prune() { for (const [id,r] of this.#records) if (r.expires <= Date.now()) this.delete(id); }
}
