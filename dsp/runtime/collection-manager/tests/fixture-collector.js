#!/usr/bin/env node
'use strict';

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.method === 'collection.resolve-targets') {
      const input = request.input;
      const date = input.date || input.start || input.key;
      process.stdout.write(`${JSON.stringify({ ok: true, status: 'succeeded', data: {
        targetType: 'day', targets: [{ key: date, start: date, end: input.end || date, values: { label: date } }],
      } })}\n`);
      return;
    }
    if (request.method === 'fixture.sync') {
      if (request.input.behavior === 'sleep') {
        setTimeout(() => process.stdout.write('{"ok":true,"status":"no_change","data":{"checked":true,"changeCount":0}}\n'), 10_000);
        return;
      }
      const status = request.input.behavior === 'published' ? 'published' : 'no_change';
      process.stdout.write(`${JSON.stringify({ ok: true, status, data: {
        checked: true,
        businessDate: '2026-08-29',
        businessTimezone: 'America/Los_Angeles',
        changeCount: status === 'published' ? 1 : 0,
        label: request.input.label || null,
      } })}\n`);
      return;
    }
    if (request.method === 'fixture.unstable' && request.attempt === 1) {
      process.stdout.write('{"ok":false,"status":"failed","error":{"code":"temporary_failure"}}\n');
      return;
    }
    if (request.method === 'fixture.sleep') {
      setTimeout(() => process.stdout.write('{"ok":true,"status":"succeeded","data":{"slept":true}}\n'), 10_000);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'succeeded',
      data: {
        runId: request.runId,
        source: request.source.id,
        method: request.method,
        attempt: request.attempt,
        label: request.input.label || null,
      },
    })}\n`);
  } catch {
    process.stdout.write('{"ok":false,"status":"failed","error":{"code":"invalid_request"}}\n');
  }
});
