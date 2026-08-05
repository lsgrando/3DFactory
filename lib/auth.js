const crypto = require('crypto');

function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(senha, salt, hash) {
  const hashVerify = crypto.scryptSync(senha, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashVerify, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };
