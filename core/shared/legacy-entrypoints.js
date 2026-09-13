'use strict';
// Executable addresses persisted in DSP collection definitions and queued work.
module.exports = Object.freeze({
  paycom: Object.freeze(['dispatch-paycom-collector', 'dispatch-paycom-activation-evidence', 'dispatch-paycom-publication-continuity']),
  cdf: Object.freeze(['dispatch-cdf-collector']),
});
