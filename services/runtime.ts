import { Storage } from './storage/index.js';
import { Accounts } from './accounts/index.js';
import { Audit } from './audit/index.js';
import { Dsps } from './dsps/index.js';
import { Mailer } from './accounts/mail.js';
import { BrowserManager } from './browsers/manager.js';
import { AuthBroker } from './auth-broker/index.js';
import { Runner } from './jobs/runner.js';
import type { Config } from './config.js';
export class Runtime {
  readonly storage: Storage;
  readonly accounts: Accounts;
  readonly audit: Audit;
  readonly dsps: Dsps;
  readonly mail: Mailer;
  readonly browsers: BrowserManager;
  readonly broker: AuthBroker;
  readonly runner: Runner;
  private mailTimer?: ReturnType<typeof setInterval>;
  constructor(readonly config: Config) {
    this.storage = new Storage(config);
    this.audit = new Audit(this.storage);
    this.accounts = new Accounts(this.storage, this.audit);
    this.dsps = new Dsps(this.storage, this.audit);
    this.mail = new Mailer(this.storage);
    this.browsers = new BrowserManager(this.storage);
    this.broker = new AuthBroker(this.storage, this.audit, this.browsers);
    this.runner = new Runner(this.storage, this.broker, this.audit);
  }
  start() {
    this.runner.start();
    if (this.config.standalone || this.config.environment === 'production') {
      this.mailTimer = setInterval(() => void this.mail.tick(), 5000);
      this.mailTimer.unref();
    }
  }
  async close() {
    if (this.mailTimer) clearInterval(this.mailTimer);
    await this.runner.close();
    this.storage.close();
  }
}
