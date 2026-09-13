import { ApiError } from "./api.ts";
export function errorMessage(error: unknown): string {
  const code =
    typeof error === "string"
      ? error
      : error instanceof ApiError
        ? error.code
        : "";
  const messages: Record<string, string> = {
    dsp_view_scope:
      "Exit this DSP to use platform controls or switch accounts.",
    dsp_view_unavailable:
      "This DSP view expired or is no longer available. Open it again from DSPs.",
    dsp_view_changed:
      "The DSP view changed. Refresh to load the current workspace.",
    invalid_input:
      "Check the fields and use a valid station code and business timezone.",
    container_provisioning_required:
      "DSP provisioning is not configured on this server. Contact the platform operator.",
    native_migration_required:
      "Finish migrating or removing existing legacy DSPs before starting this update.",
    organization_details_required:
      "Finish your DSP details before continuing setup.",
    organization_details_complete: "Your DSP details have already been saved.",
    update_unavailable:
      "This update is no longer available. Refresh and try again.",
    rollout_in_progress: "A rollout is already in progress.",
    rollout_empty: "Create a DSP before starting a rollout.",
    rollout_not_active: "There is no active rollout to change.",
    invalid_credentials: "The email address or password was not accepted.",
    password_reset_invalid:
      "This reset link is invalid or has expired. Request a new link to continue.",
    password_recovery_rate_limited:
      "Too many recovery attempts. Please try again in 15 minutes.",
    password_recovery_busy:
      "Password recovery is busy. Please try again shortly.",
    password_recovery_unavailable:
      "Password recovery is temporarily unavailable. Please contact your Dispatch administrator.",
    turnstile_required: "Complete the security check before continuing.",
    turnstile_invalid:
      "The security check was not accepted. Please verify again and retry.",
    turnstile_unavailable:
      "Security verification is temporarily unavailable. Please try again shortly.",
    login_rate_limited: "Too many sign-in attempts. Wait before trying again.",
    invitation_invalid:
      "This invitation is invalid, expired, revoked, or already used.",
    invitation_email_mismatch:
      "Sign in with the exact email address named by this invitation.",
    password_policy_failed: "Use a password containing at least 12 characters.",
    password_confirmation_mismatch: "The password confirmation does not match.",
    user_already_belongs_to_dsp: "This user already belongs to another DSP.",
    current_password_invalid: "The current password was not accepted.",
    password_unchanged:
      "Choose a new password that differs from the current password.",
    account_exists:
      "An account already exists for this invitation. Sign in instead.",
    invitation_pending: "A pending invitation already exists for that email.",
    membership_exists: "That user already belongs to this DSP.",
    conflict: "That name or account is already in use.",
    role_in_use: "Move all members off this role before deleting it.",
    fixed_roles_only:
      "DSP roles are fixed to Owner, Manager, Dispatcher, and Driver.",
    last_owner_protected:
      "Assign another Owner before changing or removing the last Owner.",
    system_role_protected: "System roles are protected and cannot be changed.",
    role_not_assignable: "Choose a standard role from this DSP.",
    self_role_change_forbidden: "You cannot change your own role.",
    organization_forbidden:
      "Your account does not have permission for that DSP.",
    workforce_changed: "The employee list changed while loading. Please retry.",
    workforce_unavailable:
      "Workforce data is temporarily unavailable. Please retry.",
    not_initialized: "Paycom has not collected workforce data yet.",
    employee_not_found: "This employee is no longer in the collected roster.",
    paycom_credentials_invalid:
      "Complete all Paycom fields and enter five distinct security PINs in their original Paycom numbering.",
    confirmation_mismatch: "Type the DSP name exactly as displayed to confirm.",
    primary_credentials_rejected:
      "Paycom did not accept the client code, username or password.",
    security_answers_rejected: "Paycom did not accept the security PINs.",
    attempt_cooldown:
      "Paycom setup is waiting for the authentication cooldown. Retry after it clears.",
    profile_locked:
      "This Paycom profile is locked. Review the failure before replacing its credentials.",
    provider_setup_failed:
      "Paycom setup could not complete. Review your details and retry.",
    profile_exists:
      "Paycom credentials are already saved. Select replacement only if you intend to change them.",
    captcha_required:
      "Paycom needs verification. Contact the Platform Owner.",
    manual_verification_required:
      "Paycom needs verification. Contact the Platform Owner.",
    mfa_required:
      "Paycom requires additional verification. Resolve it with your authorized Paycom administrator before retrying.",
    account_locked:
      "Paycom reports that the account is locked. Resolve the lock before retrying.",
    setup_interrupted: "Setup was interrupted. Review your details and retry.",
    platform_forbidden:
      "You do not have permission to manage DSP installations.",
    platform_control_invalid:
      "This control expired or belongs to another session. Refresh and try again.",
    installation_operator_disabled:
      "DSP provisioning is not enabled on this server. Server setup must be completed before creating DSPs or starting updates.",
    invitation_email_unavailable:
      "Invitation email is not configured on this server. No invitation was sent. Contact the platform owner to finish email setup.",
    dashboard_unavailable:
      "Dispatch is temporarily unavailable. Refresh to check whether your request completed before trying again.",
    installation_revision_conflict:
      "The installation changed in another session. Refresh before trying again.",
    installation_operation_in_progress:
      "An installation operation is already in progress. Its status will keep updating.",
    installation_operation_not_allowed:
      "This installation cannot be changed from its current state.",
    installation_operation_not_found:
      "That installation operation is no longer available. Refresh the status.",
    idempotency_conflict:
      "This request was reused for different input. Refresh and try again.",
    installation_not_ready:
      "This DSP runtime is not ready yet. Operational data will be available after setup completes.",
    provider_auth_required:
      "Paycom access needs attention. Contact the platform owner for assistance.",
    first_publication_failed:
      "Private runtime verification did not complete. Contact the platform operator.",
    runtime_boundary_violation:
      "The private runtime could not be verified. Contact the platform operator.",
  };
  return (
    messages[code] || "The request could not be completed. Please try again."
  );
}
