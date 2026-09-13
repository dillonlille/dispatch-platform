'use strict';

const readline = require('node:readline/promises');

function cancelled() { throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); }
function validText(value) { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n\0]/.test(value); }

class LineInteraction {
  #input;
  #output;
  #signal;
  #rl = null;

  constructor({ input = process.stdin, output = process.stdout, signal = null } = {}) {
    this.#input = input;
    this.#output = output;
    this.#signal = signal;
  }

  available() {
    return this.#input?.isTTY === true && this.#output?.isTTY === true;
  }

  #interface() {
    if (!this.available()) throw Object.assign(new Error('interaction_unavailable'), { code: 'interaction_unavailable' });
    if (!this.#rl) this.#rl = readline.createInterface({ input: this.#input, output: this.#output, terminal: false });
    return this.#rl;
  }

  write(text = '') {
    if (typeof text !== 'string' || text.length > 4096 || text.includes('\0')) throw new TypeError('invalid_interaction_text');
    this.#output.write(`${text}\n`);
  }

  async select({ message, options, defaultValue }) {
    if (!validText(message) || !Array.isArray(options) || options.length < 1 || options.length > 12
        || options.some(option => !option || !validText(option.label) || !validText(option.value))
        || new Set(options.map(option => option.value)).size !== options.length
        || !options.some(option => option.value === defaultValue)) throw new TypeError('invalid_interaction_menu');

    const rl = this.#interface();
    this.write(`? ${message}`);
    options.forEach((option, index) => this.write(`  ${index + 1}. ${option.label}${option.value === defaultValue ? ' (default)' : ''}`));
    while (true) {
      if (this.#signal?.aborted) cancelled();
      let answer;
      let onClose;
      const closed = new Promise((unused, reject) => {
        onClose = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        rl.once('close', onClose);
      });
      try {
        answer = (await Promise.race([
          rl.question(`Select [1-${options.length}, q to cancel]: `, { signal: this.#signal || undefined }),
          closed,
        ])).trim();
      }
      catch (error) {
        if (this.#signal?.aborted || error?.name === 'AbortError' || error?.code === 'cancelled'
            || error?.code === 'ERR_USE_AFTER_CLOSE') cancelled();
        throw error;
      } finally { rl.removeListener('close', onClose); }
      if (answer === '') return defaultValue;
      if (['q', 'quit', 'cancel'].includes(answer.toLowerCase())) cancelled();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
      this.write(`  Enter a number from 1 to ${options.length}, or q to cancel.`);
    }
  }

  async confirm({ message, defaultValue = false }) {
    if (!validText(message) || typeof defaultValue !== 'boolean') throw new TypeError('invalid_interaction_confirmation');
    return (await this.select({
      message,
      options: [
        { value: 'yes', label: 'Continue' },
        { value: 'no', label: 'Cancel' },
      ],
      defaultValue: defaultValue ? 'yes' : 'no',
    })) === 'yes';
  }

  close() {
    if (this.#rl) this.#rl.close();
    this.#rl = null;
  }
}

module.exports = { LineInteraction };
