'use strict';
// Synthetic, local-only browser work. Never enrolls credentials or contacts a
// provider. Measurements are a sizing aid, not a Paycom throughput guarantee.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ChromeBrowserRuntime } = require('../../auth-broker/src/browser-runtime');
const { CdpConnection, createTarget } = require('../../auth-broker/src/cdp');
function parse(argv) {
  const options = { dsps: [1, 2, 4], workers: 2, seconds: 5 };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--dsps', '--workers', '--seconds'].includes(name) || argv[i + 1] === undefined) throw Error('invalid_probe_options');
    options[name.slice(2)] = name === '--dsps' ? argv[i + 1].split(',').map(Number) : Number(argv[i + 1]);
  }
  if (options.dsps.length < 1 || options.dsps.length > 8 || options.dsps.some(n => !Number.isInteger(n) || n < 1 || n > 8)
      || !Number.isInteger(options.workers) || options.workers < 1 || options.workers > 6
      || !Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 60) throw Error('invalid_probe_options');
  return options;
}
function cpu() {
  return os.cpus().reduce((sum, item) => ({ idle: sum.idle + item.times.idle,
    total: sum.total + Object.values(item.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}
function descendantsMemory() {
  const processes = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const value = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      processes.push({ pid: Number(pid), parent: Number(/^PPid:\s+(\d+)/m.exec(value)?.[1]), rss: Number(/^VmRSS:\s+(\d+)/m.exec(value)?.[1] || 0) * 1024 });
    } catch {}
  }
  const selected = new Set([process.pid]);
  let changed = true;
  while (changed) { changed = false; for (const item of processes) if (!selected.has(item.pid) && selected.has(item.parent)) { selected.add(item.pid); changed = true; } }
  return processes.filter(item => selected.has(item.pid) && item.pid !== process.pid).reduce((sum, item) => sum + item.rss, 0);
}
const expression = `(() => {
  document.body.innerHTML = '<table>' + Array.from({length: 500}, (_, i) => '<tr><td>Fixture ' + i + '</td><td>8.00</td></tr>').join('') + '</table>';
  return Array.from(document.querySelectorAll('tr')).reduce((sum, row) => sum + Number(row.cells[1].textContent), 0);
})()`;
async function measure({ dsps, workers, seconds }, { browser = process.env.DISPATCH_CHROME_EXECUTABLE || '/opt/google/chrome/chrome' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dprobe-'));
  const browsers = [], connections = [], samples = [];
  let timer;
  const begun = performance.now();
  const cpuBefore = cpu();
  let peakRss = 0;
  let minFreeMemory = os.freemem();
  const sample = () => { peakRss = Math.max(peakRss, descendantsMemory()); minFreeMemory = Math.min(minFreeMemory, os.freemem()); };
  try {
    timer = setInterval(sample, 250);
    // Launch failures are settled before cleanup so a late launch cannot leak.
    const launches = await Promise.allSettled(Array.from({ length: dsps }, async (_, i) => {
      const directory = path.join(root, String(i)); fs.mkdirSync(directory, { mode: 0o700 });
      const runtime = new ChromeBrowserRuntime({ stateRoot: path.join(directory, 'sessions'), socketRoot: directory,
        executable: browser, headless: true, transport: 'pipe' });
      const instance = await runtime.launch(); browsers.push(instance);
      const targets = await Promise.allSettled(Array.from({ length: workers }, async () => {
        const target = await createTarget(instance.endpoint, 'about:blank');
        const connection = await CdpConnection.connect(target.webSocketDebuggerUrl); connections.push(connection);
      }));
      if (targets.some(result => result.status === 'rejected')) throw Error('probe_target_failed');
    }));
    if (launches.some(result => result.status === 'rejected')) throw Error('probe_browser_failed');
    const startupMs = performance.now() - begun;
    const deadline = performance.now() + seconds * 1000;
    let failures = 0;
    await Promise.all(connections.map(async connection => {
      while (performance.now() < deadline) {
        const start = performance.now();
        try {
          const value = await connection.command('Runtime.evaluate', { expression, returnByValue: true });
          if (value.result?.value !== 4000) throw Error('probe_result_invalid');
          samples.push(performance.now() - start);
        } catch { failures += 1; break; }
      }
    }));
    sample();
    const cpuAfter = cpu();
    samples.sort((a, b) => a - b);
    const percentile = fraction => samples.length ? Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]) : null;
    return { dsps, workersPerDsp: workers, totalWorkers: connections.length, startupMs: Math.round(startupMs), seconds,
      successfulOperations: samples.length, failures, operationP50Ms: percentile(0.5), operationP95Ms: percentile(0.95),
      peakBrowserRssBytes: peakRss, minHostFreeMemoryBytes: minFreeMemory,
      hostCpuBusyPercent: Math.round(100 * (1 - (cpuAfter.idle - cpuBefore.idle) / Math.max(1, cpuAfter.total - cpuBefore.total))) };
  } finally {
    clearInterval(timer);
    for (const connection of connections) connection.close();
    const results = await Promise.allSettled(browsers.map(browser => browser.close()));
    fs.rmSync(root, { recursive: true, force: true });
    if (results.some(result => result.status === 'rejected')) throw Error('probe_cleanup_failed');
  }
}
async function main(argv) {
  const options = parse(argv);
  const samples = [];
  for (const dsps of options.dsps) samples.push(await measure({ ...options, dsps }));
  return { workload: 'synthetic_local_browser', livePaycomVerified: false, hostCpus: os.availableParallelism(),
    hostMemoryBytes: os.totalmem(), samples };
}
if (require.main === module) main(process.argv.slice(2)).then(result => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.samples.some(sample => sample.failures)) process.exitCode = 1;
}).catch(() => { process.stderr.write('Collection capacity probe failed.\n'); process.exitCode = 1; });
module.exports = { parse, measure };
