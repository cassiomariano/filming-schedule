// vault.js — sealed boxes for moving your schedule privately through this public repository.
//
// seal(publicKeyPem, data)  → a box only the matching PRIVATE key can open
// open(privateKeyPem, box)  → the data again
//
// A random AES-256 key encrypts the data; RSA-OAEP locks that key. Without the private key,
// the box is unreadable, so it is safe even in a public repository.
const crypto = require("crypto");

function seal(publicKeyPem, data) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), "utf8")), cipher.final()]);
  const lockedKey = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { v: 1, k: lockedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: body.toString("base64") };
}

function open(privateKeyPem, box) {
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(box.k, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

module.exports = { seal, open };
