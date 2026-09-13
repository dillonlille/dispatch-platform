'use strict';
const { AccessError } = require('../accounts/src');
function createHandler({ runtimeContext, access, accessHttp, config, now, readJson,
  sendJson: send, dailyQuery, publicSdkFailure, publicSyncView, publicSdkResult, integerParameter, IDEMPOTENCY_RE }) {
  return async function handle(request, response, url) {
    const sendJson = (response, status, value) => {
      runtimeContext(request, 'workforce.read');
      return send(response, status, value);
    };
      if (request.method === 'GET' && url.pathname === '/api/paycom/daily') {
        const { runtime } = runtimeContext(request, 'workforce.read');
        const query = dailyQuery(url.searchParams);
        const [workforce, syncResult] = await Promise.all([
          runtime.workforce.day(query),
          runtime.sync.status(config.syncId),
        ]);
        const workforceError = workforce.ok ? null : publicSdkFailure(workforce, 'workforce_unavailable');
        const statusCode = workforce.ok ? 200 : workforceError.code === 'invalid_input' ? 400 : 503;
        sendJson(response, statusCode, {
          ok: workforce.ok,
          status: workforce.ok ? workforce.status : workforceError.code,
          data: workforce.ok ? {
            day: workforce.data,
            sync: publicSyncView(syncResult),
            generatedAt: now().toISOString(),
          } : null,
          error: workforceError,
        });
        return true;
      }

      if (request.method === 'GET' && (url.pathname === '/api/paycom/employees' || url.pathname.startsWith('/api/paycom/employees/'))) {
        const { runtime } = runtimeContext(request, 'workforce.read');
        const { workforceQuery, workforceEmployeeCode } = require('../../shared/contracts/src/workforce');
        let result;
        if (url.pathname === '/api/paycom/employees') {
          if ([...url.searchParams.keys()].some(key => !['limit', 'offset'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new AccessError('invalid_input', 400);
          const query = workforceQuery({
            limit: integerParameter(url.searchParams.get('limit'), 100, { minimum: 1, maximum: 100 }),
            offset: integerParameter(url.searchParams.get('offset'), 0),
          });
          result = typeof runtime.workforce.employees === 'function' ? await runtime.workforce.employees(query) : null;
        } else {
          if (url.search) throw new AccessError('invalid_input', 400);
          let code;
          try { code = workforceEmployeeCode(url.pathname.slice('/api/paycom/employees/'.length)); }
          catch { throw new AccessError('invalid_input', 400); }
          result = typeof runtime.workforce.employee === 'function' ? await runtime.workforce.employee(code) : null;
        }
        if (!result) throw new AccessError('workforce_unavailable', 503);
        const error = result.ok ? null : publicSdkFailure(result, 'workforce_unavailable');
        sendJson(response, result.ok ? 200 : error.code === 'employee_not_found' ? 404 : error.code === 'invalid_input' ? 400 : 503, {
          ok: result.ok, status: result.status, data: result.ok ? result.data : null, error,
        });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/paycom/sync') {
        if (url.search) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
        const { runtime } = runtimeContext(request, 'workforce.read');
        const result = publicSyncView(await runtime.sync.status(config.syncId));
        sendJson(response, result.ok ? 200 : 503, result);
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/paycom/sync') {
        const context = runtimeContext(request, 'sync.run');
        accessHttp.requireMutation(request, context.session, url);
        const body = await readJson(request);
        if (Object.keys(body).sort().join(',') !== 'idempotencyKey'
            || typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_RE.test(body.idempotencyKey)) {
          throw Object.assign(new Error('invalid_input'), { statusCode: 400 });
        }
        const result = await context.runtime.sync.runNow(config.syncId, {
          idempotencyKey: body.idempotencyKey,
        });
        access.audit({
          actorUserId: context.session.user.id, organizationId: context.organization.id,
          action: 'sync.run.request', targetType: 'sync', targetId: config.syncId,
          result: result.ok ? 'succeeded' : 'denied',
        });
        sendJson(response, result.ok ? 202 : 409, publicSdkResult(result, 'sync_unavailable'));
        return true;
      }

    return false;
  };
}
module.exports = { createHandler };
