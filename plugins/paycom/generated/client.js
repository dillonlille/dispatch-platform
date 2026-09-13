'use strict';
// Generated from dispatch-plugin.json. Do not edit.
const { createOperationClient } = require('dispatch-sdk/operations');
const actions = [
  {
    "id": "workforce.day",
    "permission": "workforce.read",
    "input": {
      "type": "object",
      "properties": {
        "query": {
          "type": "object",
          "properties": {
            "date": {
              "type": "string",
              "maxLength": 256
            },
            "search": {
              "type": "string",
              "maxLength": 256
            },
            "attention": {
              "type": "string",
              "maxLength": 256
            },
            "lifecycleStatus": {
              "type": "string",
              "maxLength": 256
            },
            "limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "offset": {
              "type": "integer",
              "minimum": 0
            },
            "sort": {
              "type": "string",
              "maxLength": 256
            },
            "direction": {
              "type": "string",
              "maxLength": 256
            },
            "department": {
              "type": "string",
              "maxLength": 256
            },
            "station": {
              "type": "string",
              "maxLength": 256
            }
          },
          "required": [],
          "additionalProperties": false
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "workforce.employees",
    "permission": "workforce.read",
    "input": {
      "type": "object",
      "properties": {
        "query": {
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
            },
            "lifecycleStatus": {
              "type": "string",
              "maxLength": 256
            }
          },
          "required": [],
          "additionalProperties": false
        }
      },
      "required": [
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "workforce.employee",
    "permission": "workforce.read",
    "input": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "maxLength": 256
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "sync.status",
    "permission": "workforce.read",
    "input": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "enum": [
            "paycom-main-workforce"
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "sync.run_now",
    "permission": "sync.run",
    "input": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "enum": [
            "paycom-main-workforce"
          ]
        },
        "options": {
          "type": "object",
          "properties": {
            "idempotencyKey": {
              "type": "string",
              "minLength": 16,
              "maxLength": 128
            }
          },
          "required": [],
          "additionalProperties": false
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  }
];
function createClient(invoke) { return createOperationClient({ actions, invoke }); }
module.exports = { createClient };
