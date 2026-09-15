import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Employee, Timecard } from '../shared/contracts/index.js';
import { AppError, assert } from '../shared/errors.js';

const unavailable = () => new AppError('rust_backend_unavailable', 503);
export class RustBackend {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private directory?: string;
  private socket?: string;
  private closing = false;
  private retryAt = 0;
  private pending = 0;
  private readonly requests = new Set<http.ClientRequest>();
  constructor(private readonly config: Config) {}

  get pid() {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    assert(!this.closing, 'rust_backend_unavailable', 503);
    if (this.starting) return this.starting;
    if (this.child) return;
    assert(Date.now() >= this.retryAt, 'rust_backend_unavailable', 503);
    const bundled = process.env.DISPATCH_BUNDLED === '1';
    const executable =
      this.config.rustBackendPath ??
      fileURLToPath(
        new URL(
          bundled ? '../services/rust/dispatch-backend' : '../target/debug/dispatch-backend',
          import.meta.url,
        ),
      );
    // The verified archive intentionally discards tar permissions. Restore only
    // this known executable's owner bit; file content remains in release.json.
    if (bundled) {
      const info = fs.lstatSync(executable);
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'unsafe_rust_binary');
      fs.chmodSync(executable, 0o700);
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rust-'));
    fs.chmodSync(directory, 0o700);
    this.directory = directory;
    this.socket = path.join(directory, 'backend.sock');
    const child = spawn(executable, [this.socket, path.join(this.config.stateRoot, 'dsps')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
    this.child = child;
    child.stdin!.on('error', () => {});
    child.stderr!.on('data', () => {});
    child.once('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.socket = undefined;
        this.retryAt = Date.now() + 1000;
        for (const request of this.requests) request.destroy(unavailable());
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    this.starting = new Promise<void>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(unavailable());
      }, 5000);
      const failed = () => {
        clearTimeout(timeout);
        reject(unavailable());
      };
      child.once('error', failed);
      child.once('exit', failed);
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output === 'ready\n' && !this.closing) {
          clearTimeout(timeout);
          resolve();
        } else if (output.includes('\n') || output.length > 64 || this.closing) {
          child.kill('SIGKILL');
          failed();
        }
      });
    });
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async request<T>(route: '/health' | '/employee', input?: unknown): Promise<T> {
    assert(this.pending < 32, 'rust_backend_busy', 503);
    this.pending++;
    try {
      await this.start();
      const socketPath = this.socket;
      assert(socketPath && !this.closing, 'rust_backend_unavailable', 503);
      return await new Promise<T>((resolve, reject) => {
        const body = input === undefined ? undefined : JSON.stringify(input);
        const request = http.request({
          socketPath,
          path: route,
          method: body === undefined ? 'GET' : 'POST',
          agent: false,
          headers:
            body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(body),
                },
        });
        this.requests.add(request);
        const deadline = setTimeout(() => request.destroy(unavailable()), 5000);
        request.once('close', () => {
          clearTimeout(deadline);
          this.requests.delete(request);
        });
        request.once('error', () => reject(unavailable()));
        request.once('response', (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) request.destroy(unavailable());
            else chunks.push(chunk);
          });
          response.once('error', () => reject(unavailable()));
          response.once('end', () => {
            try {
              if (response.statusCode === 404) throw new AppError('employee_not_found', 404);
              if (response.statusCode === 503) throw unavailable();
              if (response.statusCode !== 200) throw new AppError('operation_failed', 500);
              resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
            } catch (error) {
              reject(error);
            }
          });
        });
        request.end(body);
      });
    } finally {
      this.pending--;
    }
  }

  employee(dspId: string, code: string) {
    return this.request<{ employee: Employee; timecards: Timecard[] }>('/employee', {
      dspId,
      code,
    });
  }

  async healthy() {
    const value = await this.request<{ status: string; protocol: number }>('/health');
    assert(value.status === 'ready' && value.protocol === 1, 'rust_backend_unavailable', 503);
  }

  async close() {
    this.closing = true;
    for (const request of this.requests) request.destroy(unavailable());
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.stdin!.end();
        child.kill('SIGTERM');
      });
    }
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
  }
}
