-- Which features a DSP has. A DSP or feature without a row is at the feature's default.
CREATE TABLE IF NOT EXISTS dsp_features (
    dsp_id TEXT NOT NULL REFERENCES dsps(id),
    feature TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    changed_by TEXT,
    changed_at TEXT NOT NULL,
    PRIMARY KEY(dsp_id,feature)
);
