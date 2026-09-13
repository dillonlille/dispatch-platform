'use strict';

const protocol = require('dispatch-protocol/gateway/protocol');
const server = require('./server');
const client = require('dispatch-protocol/gateway/client');
const managed = require('./managed-runtime');

module.exports = Object.freeze({ ...protocol, ...server, ...client, ...managed });
