export interface User {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
}
export interface Organization {
  id: string;
  name: string;
  abbreviation?: string;
  status: string;
  timezone: string;
  stations: { code: string }[];
}
export interface Membership {
  id: string;
  organizationId: string;
  roleName: string;
  roleKey?: string;
  permissions: string[];
  organization: Organization;
}
export interface Session {
  turnstile?: { siteKey: string } | null;
  authenticated: boolean;
  dspView?: { viewRef: string; access: "owner"; expiresAt: string };
  csrfToken?: string;
  user: User;
  memberships: Membership[];
  activeOrganizationId?: string;
  platformPermissions: string[];
  plugins?: import('@/plugins/registry').PluginView[];
  bootstrap?: { initialized: boolean };
}
export interface FleetOrganization extends Omit<Organization, "status"> {
  continuityRef: string;
  controlRef: string;
  organizationStatus: string;
  detailsStatus: string;
  ownerEmail?: string;
  ownerStatus: string;
  availableActions: string[];
  ownerInvitation?: { email: string };
  installation: {
    state: string;
    revision: number;
    failure?: unknown;
    availableActions: string[];
    operation?: { kind: string; status: string };
  };
}
export interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  system: boolean;
  permissions: string[];
}
export interface Member {
  id: string;
  user: User;
  role: Role;
}
export interface Invitation {
  id: string;
  email: string;
  roleName: string;
  status: string;
  expiresAt: string;
}
export interface TeamData {
  organization: Organization;
  roles: Role[];
  members: Member[];
  invitations: Invitation[];
  permissionCatalog: string[];
}
export interface AuditEvent {
  id?: string;
  action: string;
  actor: string;
  createdAt: string;
  result: string;
}
export interface AuditLogData {
  audit: AuditEvent[];
}

export interface Profile {
  status: string;
}
export interface InvitationResult {
  invitationPath?: string;
  delivery?: { status: string };
  invitation?: { email: string };
  ownerInvitation?: { email: string };
}
export interface InvitationInfo {
  kind: string;
  email: string;
  accountExists: boolean;
  expiresAt: string;
  organization?: { name: string };
  role?: { name: string };
}
