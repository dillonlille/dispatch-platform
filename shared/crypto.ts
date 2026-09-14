import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
  scrypt,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { assert } from './errors.js';
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;
export const token = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const sign = (key: Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest('base64url');
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(password: string) {
  assert(password.length >= 12 && password.length <= 128, 'password_length', 400);
  const salt = randomBytes(16).toString('hex');
  const result = await derive(password, salt);
  return `scrypt:1:${salt}:${result.toString('hex')}`;
}
export async function checkPassword(password: string, encoded: string) {
  if (password.length > 128) return false;
  const [, version, salt, expected] = encoded.split(':');
  if (version !== '1' || !salt || !expected) return false;
  const result = await derive(password, salt);
  return equal(result.toString('hex'), expected);
}
export function encrypt(key: Buffer, value: unknown, binding: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((x) => x.toString('base64url')).join('.');
}
export function decrypt<T>(key: Buffer, value: string, binding: string): T {
  const [iv, tag, body] = value.split('.').map((x) => Buffer.from(x, 'base64url'));
  assert(iv && tag && body, 'invalid_ciphertext');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(binding));
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString()) as T;
}
