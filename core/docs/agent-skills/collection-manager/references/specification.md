---
title: Collection specification reference
status: current
last_verified: 2026-09-02
---

# Collection Specification Reference

A specification is a strict JSON object with `schemaVersion`, `collectors`, `sources`, and `plans`. It contains no secrets.

## Collector

```json
{
  "id": "paycom",
  "version": "1.0.0",
  "description": "Paycom data collector",
  "command": "/absolute/owner-controlled/path/dispatch-paycom-collector",
  "sourceSchema": {
    "type": "object",
    "properties": {
      "timezone": { "type": "string", "maxLength": 64 }
    },
    "required": ["timezone"],
    "additionalProperties": false
  },
  "methods": {}
}
```

The command must be an absolute canonical regular executable owned by the current user. Symlinks, extra hard links, group/other-writable files, and non-executable files are rejected.

## Method

```json
{
  "description": "Collect one bounded pay period",
  "inputSchema": {
    "type": "object",
    "properties": {
      "periodStart": {
        "type": "string",
        "maxLength": 10,
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      },
      "periodEnd": {
        "type": "string",
        "maxLength": 10,
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      }
    },
    "required": ["periodStart", "periodEnd"],
    "additionalProperties": false
  },
  "timeoutSeconds": 900,
  "maxAttempts": 3,
  "backoffSeconds": [60, 300],
  "concurrencyKeys": [
    "auth:{authProfile}",
    "publish:paycom-timecards"
  ]
}
```

Supported primitive schema types are `string`, `integer`, `number`, and `boolean`. Rules may use `maxLength`, `minimum`, `maximum`, `enum`, and bounded `pattern`. Schemas are always closed with `additionalProperties: false`.

Concurrency substitutions:

- `{source}`
- `{authProfile}`
- `{collector}`
- `{method}`

The manager automatically adds `source:<source-id>`.

## Source

```json
{
  "id": "paycom-main",
  "collector": "paycom",
  "authProfile": "paycom-main",
  "config": {
    "timezone": "America/Los_Angeles"
  },
  "enabled": true
}
```

`authProfile` is an identifier, never credential material. Use `null` for an unauthenticated source.

## Plan

```json
{
  "id": "paycom-current-timecards",
  "source": "paycom-main",
  "method": "timecards.period",
  "schedule": {
    "type": "cron",
    "expression": "50 15 * * *",
    "timezone": "America/Los_Angeles"
  },
  "input": {
    "periodStart": "2026-08-23",
    "periodEnd": "2026-09-05"
  },
  "dependsOn": [
    {
      "plan": "paycom-main-roster",
      "maxAgeSeconds": 86400
    }
  ],
  "enabled": true,
  "timeoutSeconds": 900,
  "maxAttempts": 3
}
```

`timeoutSeconds` and `maxAttempts` are optional plan overrides. Omit them to inherit the method defaults.

Schedule forms:

```json
{"type":"manual"}
{"type":"interval","seconds":900}
{"type":"cron","expression":"50 15 * * *","timezone":"America/Los_Angeles"}
```

Cron fields are minute, hour, day-of-month, month, and day-of-week. Wildcards, lists, ranges, and steps are supported. When both day-of-month and day-of-week are restricted, standard cron OR behavior is used.

## Apply semantics

`dispatch-collectionctl apply` validates the complete supplied object in one SQLite transaction. Definitions are upserted. Omitted definitions remain present; `apply` does not prune.

After applying, verify:

```bash
$CTL collectors
$CTL methods <collector>
$CTL sources
$CTL plans
$CTL status
```
