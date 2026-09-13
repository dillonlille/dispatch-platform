import { DspAvatar } from "@/components/DspAvatar";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Ellipsis, ArrowUpRight, Eye } from "lucide-react";
import { request, idempotent, mutation, setDspView } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { FleetOrganization, InvitationResult, Session } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  PageHeading,
  RefreshButton,
  SearchInput,
  Status,
  Loading,
  EmptyState,
  Panel,
  TextField,
  ErrorNotice,
  InvitationNotice,
  SubmitButton,
  ConfirmAction,
  Notice,
} from "@/components/shared";
const deleting = (o: FleetOrganization) =>
  o.installation.operation?.kind === "destroy";
const removed = (o: FleetOrganization) =>
  deleting(o) ||
  o.installation.operation?.kind === "restore_dsp" ||
  ["decommissioning", "decommissioned"].includes(o.installation.state) ||
  o.installation.operation?.kind === "decommission";
const running = (o: FleetOrganization) =>
  !removed(o) &&
  !deleting(o) &&
  o.organizationStatus === "active" &&
  o.installation.state === "ready";
const onboarding = (o: FleetOrganization) =>
  !removed(o) &&
  !deleting(o) &&
  !running(o) &&
  o.organizationStatus !== "suspended";
const labels: Record<string, string> = {
  ready: "Running",
  pending: "Queued",
  provisioning: "Creating",
  waiting_for_owner: "Prepared",
  waiting_for_provider_auth: "Prepared",
  verifying: "Verifying",
  failed: "Needs attention",
  suspended: "Suspended",
  decommissioning: "Removing",
  decommissioned: "Removed",
};
const actionLabels: Record<string, string> = {
  provision: "Start provisioning",
  retry_provision: "Retry provisioning",
  decommission: "Remove DSP",
  destroy: "Permanently delete DSP",
  restore_dsp: "Restore DSP",
  suspend: "Suspend DSP",
  resume: "Resume DSP",
  restart: "Restart runtime",
  revoke_owner_invitation: "Revoke invitation",
  issue_owner_invitation: "Invite owner",
};
const name = (o: FleetOrganization) =>
  o.detailsStatus === "required" ? o.ownerEmail || "New DSP" : o.name;
function onboardingLabel(o: FleetOrganization) {
  return deleting(o) || removed(o)
    ? "Closed"
    : o.ownerStatus === "pending"
      ? "Invitation pending"
      : o.ownerStatus === "missing"
        ? "Invite needed"
        : o.detailsStatus !== "complete"
          ? "DSP details needed"
          : ["ready", "suspended"].includes(o.installation.state)
            ? "Complete"
            : "Finishing setup";
}
function runtimeLabel(o: FleetOrganization) {
  return deleting(o)
    ? o.installation.operation?.status === "failed"
      ? "Deletion failed"
      : "Deleting"
    : o.installation.operation?.kind === "restore_dsp"
      ? o.installation.operation.status === "failed"
        ? "Restore failed"
        : "Restoring"
      : labels[o.installation.state] || "Unavailable";
}

export function Dsps() {
  const { refresh } = useSession();
  const fleet = useQuery({
    queryKey: ["fleet"],
    queryFn: ({ signal }) =>
      request<FleetOrganization[]>("/api/platform/organizations", { signal }),
    refetchInterval: 5000,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<{
    org: FleetOrganization;
    kind: string;
  } | null>(null);
  const [inviteOrg, setInviteOrg] = useState<FleetOrganization | null>(null);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const organizations = fleet.data || [];
  const visible = organizations.filter(
    (o) =>
      (filter === "removed"
        ? removed(o)
        : filter === "running"
          ? running(o)
          : filter === "onboarding"
            ? onboarding(o)
            : !removed(o)) &&
      `${o.name} ${o.abbreviation || ""} ${o.ownerEmail || ""} ${o.stations.map((s) => s.code).join(" ")}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const detail = fleet.error
    ? undefined
    : organizations.find((o) => o.continuityRef === selected);
  const canView = (o: FleetOrganization) =>
    !removed(o) && !deleting(o) && o.organizationStatus !== "suspended";
  async function view(o: FleetOrganization) {
    setBusy(true);
    setError(null);
    try {
      const viewed = await mutation<Session>(
        "/api/platform/organization/view",
        "POST",
        { controlRef: o.controlRef },
      );
      setDspView(viewed.dspView!.viewRef);
      await refresh(viewed);
      location.hash =
        viewed.memberships[0].organization.status === "active"
          ? "#/dashboard"
          : "#/team";
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ownerEmail = new FormData(e.currentTarget).get("ownerEmail");
    try {
      const value = await idempotent<InvitationResult>(
        inviteOrg ? `${inviteOrg.continuityRef}:invite` : "organization:create",
        inviteOrg
          ? "/api/platform/organization/owner-invitation"
          : "/api/platform/organizations",
        {
          ownerEmail,
          ...(inviteOrg ? { controlRef: inviteOrg.controlRef } : {}),
        },
      );
      setResult(value);
      setCreate(false);
      setInviteOrg(null);
      await fleet.refetch();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  async function runAction(password?: string) {
    if (!action) return;
    const { org, kind } = action;
    const latest = organizations.find(
      (o) => o.continuityRef === org.continuityRef,
    );
    if (!latest) throw Error("DSP unavailable");
    const slot = `${org.continuityRef}:${kind}`;
    try {
      if (kind === "revoke_owner_invitation")
        await idempotent(
          slot,
          "/api/platform/organization/owner-invitation/revoke",
          { controlRef: latest.controlRef },
        );
      else
        await idempotent(
          slot,
          `/api/platform/installation/${({ provision: "provision", retry_provision: "retry", decommission: "remove", destroy: "delete", restore_dsp: "restore", suspend: "suspend", resume: "resume", restart: "restart" } as Record<string, string>)[kind]}`,
          {
            controlRef: latest.controlRef,
            expectedRevision: latest.installation.revision,
            ...(kind === "destroy" ? { password } : {}),
          },
        );
      setNotice(`${org.name}: request accepted.`);
    } finally {
      await fleet.refetch();
    }
  }
  function actions(o: FleetOrganization) {
    return [...o.installation.availableActions, ...o.availableActions].filter(
      (a) =>
        actionLabels[a] &&
        (!["destroy", "restore_dsp"].includes(a) || filter === "removed"),
    );
  }
  function pick(o: FleetOrganization, kind: string) {
    setSelected(null);
    setError(null);
    if (kind === "issue_owner_invitation") setInviteOrg(o);
    else setAction({ org: o, kind });
  }
  return (
    <>
      <PageHeading title="DSPs" description="Manage your DSPs and onboarding.">
        <Button
          onClick={() => {
            setCreate(true);
            setError(null);
          }}
        >
          <Plus data-icon="inline-start" />
          Create new DSP
        </Button>
      </PageHeading>
      <div className="inline-summary" aria-label="DSP summary">
        <span>
          <strong>{organizations.filter((o) => !removed(o)).length}</strong>{" "}
          DSPs
        </span>
        <span>
          <strong>{organizations.filter(running).length}</strong> running
        </span>
        <span>
          <strong>{organizations.filter(onboarding).length}</strong> onboarding
        </span>
      </div>
      <InvitationNotice result={result} />
      {notice && <Notice>{notice}</Notice>}
      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList variant="line" className="page-tabs">
          {[
            ["all", "All DSPs"],
            ["running", "Running"],
            ["onboarding", "Onboarding"],
            ["removed", "Removed"],
          ].map(([key, label]) => (
            <TabsTrigger value={key} key={key}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="table-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search DSPs or owner email"
        />
        <RefreshButton
          onClick={() => void fleet.refetch()}
          busy={fleet.isFetching}
        />
      </div>
      <ErrorNotice error={fleet.error} />
      <ErrorNotice error={error} />
      {fleet.isPending ? (
        <Loading />
      ) : fleet.error ? null : (
        <>
          <Table className="fleet-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">DSP</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Runtime</TableHead>
                <TableHead>Onboarding</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((o) => (
                <TableRow
                  key={o.continuityRef}
                  data-state={
                    selected === o.continuityRef ? "selected" : undefined
                  }
                >
                  <TableCell>
                    <button
                      className="identity-button"
                      onClick={() => setSelected(o.continuityRef)}
                    >
                      <DspAvatar name={name(o)} />
                      <span className="dsp-identity-copy">
                        <strong>{name(o)}</strong>
                        <span>
                          {o.detailsStatus === "complete"
                            ? o.abbreviation ||
                              o.stations.map((s) => s.code).join(", ")
                            : o.detailsStatus === "submitted"
                              ? "Applying DSP details"
                              : "Awaiting DSP details"}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {o.ownerEmail || "No owner assigned"}
                  </TableCell>
                  <TableCell>
                    <Status value={o.installation.state}>
                      {runtimeLabel(o)}
                    </Status>
                  </TableCell>
                  <TableCell>
                    <Status
                      value={
                        onboardingLabel(o) === "Complete"
                          ? "neutral"
                          : "pending"
                      }
                    >
                      {onboardingLabel(o)}
                    </Status>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${name(o)}`}
                        >
                          <Ellipsis />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            disabled={busy || !canView(o)}
                            onSelect={() => void view(o)}
                          >
                            <Eye /> View
                          </DropdownMenuItem>
                          {actions(o).map((a) => (
                            <DropdownMenuItem
                              key={a}
                              disabled={!actions(o).includes(a)}
                              variant={
                                [
                                  "destroy",
                                  "decommission",
                                  "suspend",
                                  "revoke_owner_invitation",
                                ].includes(a)
                                  ? "destructive"
                                  : "default"
                              }
                              onSelect={() => pick(o, a)}
                            >
                              {actionLabels[a]}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!visible.length && (
            <EmptyState
              title={
                search
                  ? "No DSPs match your search"
                  : filter === "removed"
                    ? "No removed DSPs"
                    : "No DSPs here yet"
              }
              description={
                search
                  ? "Try another name or email."
                  : "Create a DSP to invite its owner."
              }
            />
          )}
          <p className="table-count">
            {visible.length} DSP{visible.length !== 1 ? "s" : ""}
          </p>
        </>
      )}
      <Panel
        open={create || Boolean(inviteOrg)}
        onClose={() => {
          setCreate(false);
          setInviteOrg(null);
        }}
        title={inviteOrg ? "Invite DSP owner" : "Create new DSP"}
        description="Invite an owner. Their workspace will be prepared while they finish setup."
        busy={busy}
      >
        <form onSubmit={invite} className="panel-form">
          <FieldGroup>
            <TextField
              label="Owner email"
              name="ownerEmail"
              type="email"
              autoComplete="off"
              maxLength={254}
              required
              disabled={busy}
            />
            <ErrorNotice error={error} />
          </FieldGroup>
          <div className="panel-footer">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setCreate(false);
                setInviteOrg(null);
              }}
            >
              Cancel
            </Button>
            <SubmitButton busy={busy}>
              {inviteOrg ? "Create invitation" : "Create DSP"}
            </SubmitButton>
          </div>
        </form>
      </Panel>
      <Panel
        open={Boolean(detail)}
        onClose={() => setSelected(null)}
        title={
          detail ? (
            <span className="dsp-panel-identity">
              <DspAvatar name={name(detail)} />
              <span>{name(detail)}</span>
            </span>
          ) : (
            "DSP details"
          )
        }
        description="DSP ownership and runtime status."
      >
        {detail && (
          <div className="panel-body">
            <dl className="detail-list">
              <div>
                <dt>Owner</dt>
                <dd>{detail.ownerEmail || "Not assigned"}</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  <Status value={detail.installation.state}>
                    {runtimeLabel(detail)}
                  </Status>
                </dd>
              </div>
              <div>
                <dt>Onboarding</dt>
                <dd>{onboardingLabel(detail)}</dd>
              </div>
              <div>
                <dt>Station</dt>
                <dd>{detail.stations.map((s) => s.code).join(", ") || "—"}</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{detail.timezone || "—"}</dd>
              </div>
            </dl>
            {Boolean(detail.installation.failure) && (
              <Notice error>
                This DSP needs attention. Review its setup or retry the failed
                operation.
              </Notice>
            )}
            <div className="flex flex-col gap-2 mt-6">
              <Button
                disabled={busy || !canView(detail)}
                onClick={() => void view(detail)}
              >
                <Eye /> {busy ? "Opening…" : "View"}
              </Button>
              {!canView(detail) && (
                <p className="text-sm text-muted-foreground">
                  Viewing is unavailable for suspended or removed DSPs.
                </p>
              )}
              <ErrorNotice error={error} />
              {actions(detail).map((a) => (
                <Button
                  key={a}
                  variant="outline"
                  onClick={() => pick(detail, a)}
                >
                  {actionLabels[a]}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              ))}
            </div>
          </div>
        )}
      </Panel>
      {action && (
        <ConfirmAction
          key={`${action.org.continuityRef}:${action.kind}`}
          title={actionLabels[action.kind]}
          passwordRequired={action.kind === "destroy"}
          description={
            action.kind === "destroy"
              ? `Permanently delete ${action.org.name} and all its runtime data and backups. Everyone will lose access. This cannot be undone.`
              : action.kind === "decommission"
                ? `Remove ${action.org.name}. Access will stop immediately and its services will stop. Existing data will be retained so you can restore this DSP later.`
                : action.kind === "restore_dsp"
                  ? `Restore ${action.org.name} with its retained data and settings. Users can sign in again once services are healthy.`
                  : action.kind === "suspend"
                    ? `Suspend ${action.org.name}. User access and collection will stop. All data and saved connections will be retained.`
                    : action.kind === "resume"
                      ? `Resume ${action.org.name}. Its services and user access will return once the runtime is healthy.`
                      : action.kind === "restart"
                        ? `Restart the runtime for ${action.org.name}. Collection and user access will pause briefly.`
                  : action.kind === "revoke_owner_invitation"
                    ? `Revoke the owner invitation for ${action.org.name}? The invitation link will stop working.`
                    : `Confirm this action for ${action.org.name}.`
          }
          onClose={() => setAction(null)}
          onConfirm={runAction}
        />
      )}
    </>
  );
}
