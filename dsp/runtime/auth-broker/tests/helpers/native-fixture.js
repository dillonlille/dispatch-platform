'use strict';

const assert = require('node:assert/strict');

// Only for intercepted test pages. A navigation response does not mean that the
// selected document is loaded or that Chrome has painted its native window.
async function settleFixture(connection) {
  await connection.command('Page.bringToFront');
  const ready = await connection.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture render timed out')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve(document.readyState === 'complete' && document.visibilityState === 'visible');
    }));
  })`);
  assert.equal(ready, true, 'fixture must be loaded and visible before native interaction');
}

async function navigateFixture(connection, url, readyExpression) {
  const navigation = await connection.command('Page.navigate', { url });
  assert.equal(navigation.errorText, undefined);
  assert.ok(navigation.loaderId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      const { frameTree } = await connection.command('Page.getFrameTree');
      ready = frameTree.frame.loaderId === navigation.loaderId
        && await connection.evaluate('document.readyState') === 'complete'
        && await connection.evaluate(readyExpression);
    } catch { /* A previous document may be destroyed while navigation commits. */ }
    if (ready) return settleFixture(connection);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('requested fixture document did not load');
}

async function reportNativeFixture(connection) {
  if (!connection) return;
  try {
    const state = await connection.evaluate(`(() => ({
      ready: document.readyState, visibility: document.visibilityState,
      focused: document.hasFocus(), activeTag: document.activeElement?.tagName,
      viewport: [innerWidth, innerHeight, outerWidth, outerHeight],
      scroll: [scrollX, scrollY], scale: devicePixelRatio,
      fields: Array.from(document.querySelectorAll('input')).map(element => ({
        type: element.type, filled: !!element.value, active: element === document.activeElement,
        visible: element.offsetParent !== null, rect: element.getBoundingClientRect().toJSON(),
      })),
      buttons: Array.from(document.querySelectorAll('button')).map(element => ({
        type: element.type, visible: element.offsetParent !== null,
        rect: element.getBoundingClientRect().toJSON(),
      })),
    }))()`);
    console.error('Native fixture state:', JSON.stringify(state));
  } catch { /* Keep the original test failure when the target has closed. */ }
}

module.exports = { navigateFixture, settleFixture, reportNativeFixture };
