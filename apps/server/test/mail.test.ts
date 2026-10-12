import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-mail-"));
const { extractVerification } = await import("../src/mail/index.ts");
const { generatePassword, seal, open } = await import("../src/secrets.ts");

test("extracts verification codes in common phrasings", () => {
  const cases: [string, string][] = [
    ["Your verification code is: 482913", "482913"],
    ["Use code 7731 to sign in", "7731"],
    ["Your one-time passcode is AB12CD34. It expires in 10 minutes.", "AB12CD34"],
    ["Enter this security code: 019283 to continue", "019283"],
    ["Hi,\n\n553201\n\nThis is your sign in code.", "553201"],
  ];
  for (const [text, want] of cases) assert.equal(extractVerification({ subject: "Verify", text }).code, want, text);
});

test("ignores years and finds verification links", () => {
  const v = extractVerification({ subject: "Welcome", text: "Joined in 2024.", html: '<a href="https://acme.wd5.myworkdayjobs.com/en-US/verify?token=abc&amp;x=1">Verify</a>' });
  assert.equal(v.code, undefined);
  assert.equal(v.link, "https://acme.wd5.myworkdayjobs.com/en-US/verify?token=abc&x=1");
});

test("vault: passwords meet ATS policies and secrets round-trip", () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.ok(p.length >= 16 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p), p);
  }
  const s = seal("hunter2!");
  assert.notEqual(s, "hunter2!");
  assert.equal(open(s), "hunter2!");
});
