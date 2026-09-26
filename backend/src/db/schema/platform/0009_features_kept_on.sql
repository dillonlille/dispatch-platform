-- Features now default to off. Every DSP that existed before keeps what it had: a feature
-- without a row read as on, so it gets a row that says so. Rows already stored stay as they are.
INSERT OR IGNORE INTO dsp_features(dsp_id,feature,enabled,changed_at)
SELECT d.id,f.feature,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM dsps d
CROSS JOIN (
    SELECT 'timecard' AS feature
    UNION ALL SELECT 'uniforms'
    UNION ALL SELECT 'paycom'
    UNION ALL SELECT 'cortex'
) f;
