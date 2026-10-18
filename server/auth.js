// 비밀번호 해시와 로그인 토큰. 외부 라이브러리 없이 Node 내장 crypto만 쓴다.
const crypto = require('crypto');

const NICKNAME_PATTERN = /^[가-힣a-zA-Z0-9_]{2,12}$/;
const TOKEN_DAYS = 30;

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET이 없어 임시 값을 씁니다. 서버를 재시작하면 모두 다시 로그인해야 합니다.');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

// 토큰 = "유저id.만료시각.서명". 서버 메모리에 아무것도 저장하지 않아 재시작해도 유지된다.
function issueToken(userId) {
  const payload = `${userId}.${Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000}`;
  return `${payload}.${sign(payload)}`;
}

// 올바른 토큰이면 유저 id, 아니면 null.
function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  const expected = Buffer.from(sign(`${userId}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(expires) < Date.now()) return null;
  return Number(userId);
}

function checkCredentials(nickname, password) {
  if (typeof nickname !== 'string' || !NICKNAME_PATTERN.test(nickname)) {
    return '닉네임은 한글/영문/숫자/_ 2~12자로 정해 주세요.';
  }
  if (typeof password !== 'string' || password.length < 4 || password.length > 64) {
    return '비밀번호는 4~64자로 정해 주세요.';
  }
  return null;
}

module.exports = { hashPassword, verifyPassword, issueToken, readToken, checkCredentials };
