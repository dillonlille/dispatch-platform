CREATE TABLE IF NOT EXISTS employee_timecard_syncs (
    employee_code TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY(employee_code, period_from, period_to)
);
