import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture } from './rust-support.js';

export const credentials = {
  clientCode: 'fixture-client',
  username: 'fixture-user',
  password: 'fixture-password',
  securityAnswers: ['One', 'Two', '00 Three !', 'Four', ' Five? '],
};
const loginPath = '/v4/cl/cl-login.php',
  actionPath = '/v4/cl/cl-loginproc.php';
const pinPath = '/v4/cl/web.php/security/security-question/login';
const landing = '/v4/cl/web.php/client-landing/arc';
const login = `<form method="post" action="${actionPath}"><input name="clientcode"><input name="username"><input type="password" name="password"><button>Log in</button></form>`;
const pins = `<form method="post" action="${pinPath}"><label for="first">PIN 3</label><input id="first" name="firstSecurityQuestion" type="password"><label for="second">PIN 5</label><input id="second" name="secondSecurityQuestion" type="password"><input name="firstIndex" type="hidden" value="3"><input name="secondIndex" type="hidden" value="5"><button name="continue" type="submit">Continue</button></form>`;
const challenge = `<iframe style="position:absolute;left:500px;top:200px;width:200px;height:100px" src="/captcha/frame"></iframe><button type="button" id="solveCaptcha" style="position:absolute;left:500px;top:350px;width:140px;height:40px" onclick="document.querySelector('iframe').remove();window.fixtureSolved=true;document.cookie='fixture_captcha=solved; Path=/';this.remove()">Solve fixture</button>`;
const profilePath = '/v4/cl/web.php/two-factor/react/index/preferences/campaign';
const warning =
  'You will no longer be prompted at login to verify your info this month. You will continue to use security questions to access your account. You may verify your information at any time from your contact information page.';
const profile = `<h1>Setup Your Security Profile</h1><p>Verify your contact information</p>
<input name="cell-number"><button>Verify</button><input name="email"><button>Verify</button><input name="work-number"><button>Verify</button>
<button id="notnow" onclick="document.querySelector('#warning').hidden=false">Not Now</button>
<button onclick="if(window.confirmed){document.cookie='profile_done=true; Path=/';location.href='${landing}'}">Continue</button>
<div id="warning" hidden><p>Warning</p><p>${warning}</p><button></button><button>Cancel</button><button onclick="window.confirmed=true;this.parentElement.remove()">Continue</button></div>`;
const authenticated = '<a id="mainMenuLink">Menu</a><a id="clientLogout">Log out</a>';
const headers = [
  'date',
  'paycode',
  'i1',
  'allocation1',
  'o1',
  'i2',
  'allocation2',
  'o2',
  'hours',
  'total_hours',
  'amount',
  'exception-points',
  'waiver',
  'comment',
  'missing-punch',
  'delete',
];
const requestBody = {
  allocationCategories: [],
  approvalMode: 'pending',
  eeCodes: ['AA01', 'BB02'],
  endDate: '2026-09-12',
  getCount: true,
  highlighting: null,
  isAdvancedFilterApplied: true,
  loadTotals: true,
  minWageUrl: null,
  onlyBorrowedEmployees: false,
  payClassCodes: ['Driver'],
  q: null,
  selectedColumns: [],
  selectedEarnings: ['REG'],
  skip: null,
  sortParams: [],
  startDate: '2026-08-30',
  take: null,
};
const employee = (code: string) => ({
  employeeCode: code,
  fullName: `Fixture ${code}`,
  eestatus: 'A',
  allocation: {
    selections: [
      { categoryName: 'Department', isDepartment: true, code: 'D', description: 'Driver' },
      {
        categoryName: 'Delivery Station Code',
        isDepartment: false,
        code: 'S',
        description: 'Station',
      },
    ],
  },
  position: 'Driver',
  payClassCode: 'Driver',
  terminalCode: 'S',
  payType: 'Hourly',
  primarySupervisor: 'Fixture Manager',
  missingPunches: 0,
  totals: { totalHours: 16, otHours: 0 },
  approvalPercentages: { employee: 100, supervisor: 100 },
});
function timecard(url: URL, mismatch: boolean, dailyHours = 8) {
  const start = Date.parse(url.searchParams.get('perioddates')!.split('_')[0]!);
  const rows = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(start + index * 86400000),
      iso = date.toISOString().slice(0, 10);
    const values: Record<string, string> = {
      date: `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][index % 7]} (${iso.slice(5).replace('-', '/')})`,
      paycode: 'REG',
      hours: index % 7 === 0 ? String(dailyHours) : '0',
      total_hours: index % 7 === 0 ? String(dailyHours) : '0',
    };
    if (index % 7 === 0) {
      values.i1 = '08:00 AM';
      values.o1 = dailyHours === 9 ? '05:00 PM' : '04:00 PM';
    }
    // Paycom can leave the dated row empty and put punches and totals on a
    // following pay-code row. Extraction folds those punches into the day.
    const trailing = url.searchParams.get('firstrefno') === 'BB02' && index % 7 === 0;
    const render = (cells: Record<string, string>) =>
      `<tr>${headers.map((h) => `<td>${cells[h] ?? ''}</td>`).join('')}</tr>`;
    return (
      (trailing
        ? render({ date: values.date! }) + render({ ...values, date: '', hours: '4' })
        : render(values)) +
      (index % 7 === 6
        ? `<tr><td>Weekly Totals</td><td>${mismatch ? 9 : dailyHours}</td></tr>`
        : '')
    );
  }).join('');
  return `<title>Timecard Editor</title><input type="password" hidden aria-label="Hidden account settings"><input name="firstrefno" type="hidden" value="${url.searchParams.get('firstrefno')}"><table id="tbltimesheet"><thead><tr>${headers.map((h) => `<th data-column="${h}">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><div id="periodtotals">${dailyHours * 2}</div>`;
}
export async function paycomFixture(
  extraRoute?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
) {
  const events: string[] = [];
  const state = {
    rejection: false,
    mode: '',
    incomplete: false,
    mismatch: false,
    codes: ['AA01', 'BB02'],
    accounts: {} as Record<string, string[]>,
    accountStarts: [] as string[],
    activeByAccount: new Map<string, number>(),
    peakByAccount: new Map<string, number>(),
    timecardDelayMs: 0,
    beforeTimecard: undefined as ((account: string, code: string) => Promise<void>) | undefined,
    slowImages: false,
    hydrate: false,
    hydrated: 0,
    imagesFinished: 0,
    timecardsActive: 0,
    timecardsPeak: 0,
    timecardAccountsPeak: 0,
    wrongIdentity: false,
    timecardStatus: 200,
    missingContent: new Map<string, number>(),
    navigationStalls: new Map<string, number>(),
    readsByCode: new Map<string, number>(),
    expiredTimecard: false,
    requests: [] as Record<string, unknown>[],
  };
  const server = http.createServer(async (req, res) => {
    if (extraRoute?.(req, res)) return;
    const url = new URL(req.url!, 'http://fixture.invalid');
    const account = decodeURIComponent(
      req.headers.cookie?.match(/(?:^|; )fixture_account=([^;]+)/)?.[1] ?? credentials.username,
    );
    const accountCodes = state.accounts[account] ?? state.codes;
    const logged = !state.rejection && req.headers.cookie?.includes('fixture_session=one');
    const solved = req.headers.cookie?.includes('fixture_captcha=solved');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type', 'text/html');
    const redirect = (path: string) => {
      res.writeHead(302, { Location: path });
      res.end();
    };
    const html = (value: string) => res.end('<!doctype html>' + value);
    if (url.pathname === landing) {
      events.push('landing');
      if (logged) {
        if (state.mode === 'profile' && !req.headers.cookie?.includes('profile_done=true'))
          return redirect(profilePath);
        return html(authenticated);
      }
      return redirect(loginPath);
    }
    if (url.pathname === loginPath)
      return html(login + (state.mode === 'before-login' && !solved ? challenge : ''));
    if (url.pathname === actionPath && req.method === 'POST') {
      events.push('primary');
      const values = new URLSearchParams(text);
      if (
        state.rejection ||
        values.get('clientcode') !== credentials.clientCode ||
        (values.get('username') !== credentials.username &&
          !Object.hasOwn(state.accounts, values.get('username') ?? '')) ||
        values.get('password') !== credentials.password
      )
        return html(login + '<p>Invalid username or password</p>');
      res.setHeader(
        'Set-Cookie',
        `fixture_account=${encodeURIComponent(values.get('username')!)}; Path=/; Max-Age=3600; HttpOnly`,
      );
      return redirect(pinPath);
    }
    if (url.pathname === pinPath && req.method === 'POST') {
      events.push('pins');
      const values = new URLSearchParams(text);
      if (
        values.get('firstSecurityQuestion') !== credentials.securityAnswers[2] ||
        values.get('secondSecurityQuestion') !== credentials.securityAnswers[4]
      )
        return html(pins + '<p>Security answers are not correct</p>');
      res.setHeader('Set-Cookie', 'fixture_session=one; Path=/; Max-Age=3600; HttpOnly');
      return redirect(landing);
    }
    if (url.pathname === pinPath && url.searchParams.has('changed'))
      return html(
        pins +
          `<script>document.querySelector('#first').value='00 Three !';document.querySelector('#second').value=' Five? ';</script>`,
      );
    const manualChallenge =
      state.mode === 'changed-document'
        ? challenge.replace('this.remove()', `location.href='${pinPath}?changed=1'`)
        : state.mode === 'changed-pins'
          ? challenge.replace(
              'this.remove()',
              "document.querySelector('#first').value='changed';this.remove()",
            )
          : challenge;
    if (url.pathname === pinPath)
      return html(
        pins +
          (['after-pins', 'changed-document', 'changed-pins'].includes(state.mode)
            ? `<script>document.querySelector('form').onsubmit=e=>{if(!window.fixtureSolved){e.preventDefault();if(!document.querySelector('iframe'))document.body.insertAdjacentHTML('beforeend',${JSON.stringify(manualChallenge)});}}</script>`
            : ''),
      );
    if (url.pathname === profilePath) return html(profile);
    if (url.pathname === '/captcha/frame') return html('Fixture challenge');
    if (!logged) {
      res.writeHead(403);
      return res.end('Not authenticated');
    }
    if (url.pathname === '/v4/cl/web.php/timecardsearch/index')
      return html(
        `${authenticated}<title>Timecard Search</title><p>Employee Status Is Active</p><button>Export</button><script>fetch('/api/cl/timecard-search/employees',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture-token'},body:JSON.stringify(${JSON.stringify({ ...requestBody, eeCodes: accountCodes })})})</script>`,
      );
    if (url.pathname === '/api/cl/timecard-search/employees' && req.method === 'POST') {
      const body = JSON.parse(text);
      state.requests.push(body);
      if (req.headers['x-csrf-token'] !== 'fixture-token') {
        res.writeHead(403);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      const codes = state.incomplete ? ['AA01'] : accountCodes;
      return res.end(JSON.stringify({ eeCodes: codes, employees: codes.map(employee) }));
    }
    if (url.pathname === '/fixture/image' || url.pathname === '/fixture/hydrate') {
      const hydrate = url.pathname.endsWith('hydrate');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, hydrate ? 3000 : 30000);
        res.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (res.destroyed) return;
      if (hydrate) {
        state.hydrated++;
        return html(timecard(url, false, 9));
      }
      state.imagesFinished++;
      res.setHeader('Content-Type', 'image/png');
      return res.end();
    }
    if (url.pathname === '/v4/cl/web.php/timecard/index') {
      if (!accountCodes.includes(url.searchParams.get('firstrefno') ?? '')) {
        res.writeHead(403);
        return res.end('Employee not in this account');
      }
      if (url.searchParams.get('firstrefno') === accountCodes[0]) state.accountStarts.push(account);
      const active = (state.activeByAccount.get(account) ?? 0) + 1;
      state.activeByAccount.set(account, active);
      state.peakByAccount.set(account, Math.max(active, state.peakByAccount.get(account) ?? 0));
      const code = url.searchParams.get('firstrefno')!;
      state.readsByCode.set(code, (state.readsByCode.get(code) ?? 0) + 1);
      events.push('timecard');
      state.timecardsActive++;
      state.timecardsPeak = Math.max(state.timecardsPeak, state.timecardsActive);
      state.timecardAccountsPeak = Math.max(
        state.timecardAccountsPeak,
        [...state.activeByAccount.values()].filter((count) => count > 0).length,
      );
      try {
        await state.beforeTimecard?.(account, code);
        await new Promise<void>((resolve) => {
          const stalled = (state.navigationStalls.get(code) ?? 0) > 0;
          if (stalled) state.navigationStalls.set(code, state.navigationStalls.get(code)! - 1);
          const timer = setTimeout(resolve, stalled ? 60000 : state.timecardDelayMs);
          res.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (res.destroyed) return;
        if (state.timecardStatus !== 200 && url.searchParams.get('firstrefno') === 'BB02') {
          res.writeHead(state.timecardStatus);
          return res.end('Provider temporarily unavailable');
        }
        if (state.expiredTimecard) {
          res.writeHead(302, { Location: '/' });
          return res.end();
        }
        if ((state.missingContent.get(code) ?? 0) > 0) {
          state.missingContent.set(code, state.missingContent.get(code)! - 1);
          return html('<title>Timecard loading failed</title><p>Try again</p>');
        }
        if (state.wrongIdentity && url.searchParams.get('firstrefno') === 'BB02')
          url.searchParams.set('firstrefno', 'AA01');
        return html(
          timecard(url, state.mismatch) +
            (state.slowImages ? '<img src="/fixture/image">' : '') +
            (state.hydrate
              ? `<script>fetch('/fixture/hydrate${url.search}').then(r=>r.text()).then(html=>{const doc=new DOMParser().parseFromString(html,'text/html');document.querySelector('#tbltimesheet').replaceWith(doc.querySelector('#tbltimesheet'));document.querySelector('#periodtotals').textContent=doc.querySelector('#periodtotals').textContent;});</script>`
              : ''),
        );
      } finally {
        state.timecardsActive--;
        state.activeByAccount.set(account, (state.activeByAccount.get(account) ?? 1) - 1);
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://fixture.dispatch.invalid:${(server.address() as AddressInfo).port}`;
  const platform = await fixture({
    env: {
      DISPATCH_FIXTURE_PROVIDER_URL: url,
      DISPATCH_BWRAP_EXECUTABLE:
        process.env.DISPATCH_BWRAP_EXECUTABLE ?? '/usr/local/libexec/dispatch-dev/bwrap',
    },
  });
  return {
    ...platform,
    events,
    state,
    close: async () => {
      try {
        await platform.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
