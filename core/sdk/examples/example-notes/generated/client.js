'use strict';
// Generated from dispatch-plugin.json. Do not edit.
const { createOperationClient } = require('dispatch-sdk/operations');
const actions = [
  {
    "id": "records.list",
    "permission": "dashboard.view",
    "summary": "List entries for the current DSP",
    "input": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [],
      "additionalProperties": false
    },
    "output": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "integer",
                "minimum": 1
              },
              "text": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "id",
              "text"
            ],
            "additionalProperties": false
          },
          "maxItems": 100
        },
        "total": {
          "type": "integer",
          "minimum": 0
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "items",
        "total",
        "limit",
        "offset"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "records.add",
    "permission": "organization.settings.manage",
    "summary": "Add an entry for the current DSP",
    "input": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "idempotencyKey": {
          "type": "string",
          "minLength": 16,
          "maxLength": 128
        }
      },
      "required": [
        "text",
        "idempotencyKey"
      ],
      "additionalProperties": false
    },
    "output": {
      "type": "object",
      "properties": {
        "id": {
          "type": "integer",
          "minimum": 1
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "required": [
        "id",
        "text"
      ],
      "additionalProperties": false
    },
    "errors": [
      "entries_paused",
      "idempotency_conflict",
      "invalid_input"
    ]
  }
];
function createClient(invoke) { return createOperationClient({ actions, invoke }); }
module.exports = { createClient };
