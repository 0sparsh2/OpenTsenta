import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

// AES-256-GCM for secrets at rest (ATS passwords, IMAP app passwords, OAuth tokens).
// Key: VAULT_KEY (base64, 32 bytes) or a key file generated once under the data dir (mode 0600).

function loadKey(): Buffer {
  if (process.env.VAULT_KEY) {
    const k = Buffer.from(process.env.VAULT_KEY, "base64");
    if (k.length !== 32) throw new Error("VAULT_KEY must be 32 bytes, base64-encoded");
    return k;
  }
  const file = path.join(config.dataDir, "vault.key");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
}
const KEY = loadKey();

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function open(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/** A password that satisfies common ATS policies (length, upper, lower, digit, symbol). */
export function generatePassword(len = 18): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^*-_+="];
  const all = sets.join("");
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = sets.map(pick);
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
