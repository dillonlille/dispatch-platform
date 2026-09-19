CREATE INDEX IF NOT EXISTS throttle_expiry ON throttle(reset_at);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,available_at);
CREATE INDEX IF NOT EXISTS outbox_last_attempt ON outbox(last_attempt_at DESC);
CREATE INDEX IF NOT EXISTS outbox_sent ON outbox(sent_at DESC);
CREATE INDEX IF NOT EXISTS memberships_dsp_role ON memberships(dsp_id,role,user_id);
CREATE INDEX IF NOT EXISTS invitations_dsp_owner ON invitations(dsp_id,role,expires_at DESC) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS invitations_expiry ON invitations(expires_at);
CREATE INDEX IF NOT EXISTS resets_expiry ON resets(expires_at);
