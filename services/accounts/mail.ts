import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import type { Storage } from '../storage/index.js';
import { decrypt, encrypt, id } from '../../shared/crypto.js';
import { privateDirectory, atomicPrivateWrite } from '../storage/paths.js';
interface Mail {
  to: string;
  subject: string;
  text: string;
}
export class Mailer {
  private running = false;
  constructor(private storage: Storage) {}
  available() {
    return (
      this.storage.config.development ||
      Boolean(this.storage.config.smtpUrl && this.storage.config.mailFrom)
    );
  }
  enqueue(message: Mail) {
    if (!this.available()) return false;
    const key = id('mail');
    this.storage.platform.run(
      'INSERT INTO outbox(id,encrypted_message,available_at) VALUES (?,?,?)',
      key,
      encrypt(this.storage.key, message, key),
      Date.now(),
    );
    return true;
  }
  async tick() {
    if (this.running || !this.available()) return;
    this.running = true;
    try {
      const rows = this.storage.platform.all<{
        id: string;
        encrypted_message: string;
        attempts: number;
      }>(
        "SELECT * FROM outbox WHERE status='pending' AND available_at<=? ORDER BY available_at LIMIT 4",
        Date.now(),
      );
      for (const row of rows) {
        try {
          const message = decrypt<Mail>(this.storage.key, row.encrypted_message, row.id);
          if (this.storage.config.development) {
            const directory = privateDirectory(
              path.join(this.storage.paths.platform, 'development-mail'),
            );
            atomicPrivateWrite(path.join(directory, `${row.id}.json`), JSON.stringify(message));
          } else if (this.storage.config.smtpUrl) {
            const transport = nodemailer.createTransport(this.storage.config.smtpUrl);
            try {
              await transport.sendMail({ ...message, from: this.storage.config.mailFrom });
            } finally {
              transport.close();
            }
          }
          this.storage.platform.run(
            "UPDATE outbox SET status='sent',encrypted_message='',sent_at=? WHERE id=?",
            new Date().toISOString(),
            row.id,
          );
        } catch {
          this.storage.platform.run(
            'UPDATE outbox SET attempts=attempts+1,status=?,available_at=? WHERE id=?',
            row.attempts >= 4 ? 'failed' : 'pending',
            Date.now() + 60_000 * 2 ** row.attempts,
            row.id,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
