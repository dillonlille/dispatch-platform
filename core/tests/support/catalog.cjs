'use strict';
const manifest = require('../fixtures/paycom-plugin.json');
require('../../shared/plugin-sdk/catalog').configureCatalog(() => [manifest]);
require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(() => [manifest]);
