import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Ellipsis } from "lucide-react";
import { activeMembership, has, mutation, request } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTimezone } from "@/lib/timezone";
import type { TeamData, Member, InvitationResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Table,
  TableHead,
  TableHeader,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  PageHeading,
  SearchInput,
  RefreshButton,
  Status,
  Loading,
  ErrorNotice,
  EmptyState,
  Panel,
  TextField,
  SubmitButton,
  InvitationNotice,
  ConfirmAction,
  dateTime,
  Notice,
} from "@/components/shared";
import { DspProfile } from "./Settings.tsx";
type Editor = { kind: "invite" } | { kind: "member"; member: Member };
export function Team() {
  const { session } = useSession();
  const { timeZone } = useTimezone();
  const membership = activeMembership(session);
  const suspended = membership?.organization.status === "suspended";
  const team = useQuery({
    queryKey: ["team", membership?.organizationId],
    queryFn: ({ signal }) =>
      request<TeamData>("/api/organization/administration", { signal }),
    enabled: !suspended,
    refetchInterval: 15000,
  });
  const [tab, setTab] = useState("members");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    path: string;
  } | null>(null);
  const data = team.data;
  const roles =
    data?.roles.filter((r) =>
      r.permissions.every((p) => membership?.permissions.includes(p)),
    ) || [];
  const members =
    data?.members.filter((m) =>
      `${m.user.name} ${m.user.email}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  function open(value: Editor) {
    setError(null);
    setEditor(value);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editor) return;
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      if (editor.kind === "invite") {
        setResult(
          await mutation<InvitationResult>(
            "/api/organization/invitations",
            "POST",
            { email: form.get("email"), roleId: form.get("roleId") },
          ),
        );
      } else if (editor.kind === "member")
        await mutation(
          `/api/organization/members/${editor.member.id}/role`,
          "PUT",
          { roleId: form.get("roleId") },
        );
      setEditor(null);
      await team.refetch();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  const invites = data?.invitations.filter((i) => i.status === "pending") || [];
  return (
    <>
      <PageHeading
        title="Team & Roles"
        description="Manage your team and their access."
      >
        {!suspended && has(membership, "members.invite") && (
          <Button onClick={() => open({ kind: "invite" })}>
            <Plus data-icon="inline-start" />
            Invite member
          </Button>
        )}
      </PageHeading>
      {suspended ? (
        <Notice>
          This DSP is suspended. Team administration is unavailable.
        </Notice>
      ) : (
        <>
          <DspProfile />
          <InvitationNotice result={result} />
          <ErrorNotice error={team.error} />
          {team.isPending ? (
            <Loading />
          ) : data && !team.error ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList variant="line" className="page-tabs">
                <TabsTrigger value="members">Members</TabsTrigger>
                <TabsTrigger value="roles">Roles</TabsTrigger>
                <TabsTrigger value="invitations">
                  Invitations
                  {invites.length > 0 && (
                    <span className="tab-count">{invites.length}</span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="members">
                <div className="table-toolbar">
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="Search members"
                  />
                  <RefreshButton
                    onClick={() => void team.refetch()}
                    busy={team.isFetching}
                  />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[45%]">Member</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Access</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="member-identity">
                            <span className="avatar">
                              {m.user.name
                                .split(/\s+/)
                                .map((n) => n[0])
                                .slice(0, 2)
                                .join("")}
                            </span>
                            <div>
                              <strong>{m.user.name}</strong>
                              <span>{m.user.email}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{m.role.name}</TableCell>
                        <TableCell>
                          <Status value="active">Active</Status>
                        </TableCell>
                        <TableCell className="text-right">
                          {m.user.id !== session.user.id &&
                            has(membership, "members.manage") && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Actions for ${m.user.name}`}
                                  >
                                    <Ellipsis />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuGroup>
                                    <DropdownMenuItem
                                      onSelect={() =>
                                        open({ kind: "member", member: m })
                                      }
                                    >
                                      Change role
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onSelect={() =>
                                        setConfirm({
                                          title: "Remove member",
                                          description: `Remove ${m.user.name} from ${data.organization.name}?`,
                                          path: `/api/organization/members/${m.id}`,
                                        })
                                      }
                                    >
                                      Remove member
                                    </DropdownMenuItem>
                                  </DropdownMenuGroup>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!members.length && (
                  <EmptyState
                    title="No members found"
                    description="Try a different name or email."
                  />
                )}
                <p className="table-count">
                  {members.length} member{members.length !== 1 ? "s" : ""}
                </p>
              </TabsContent>
              <TabsContent value="roles">
                <div className="table-toolbar">
                  <p className="text-sm text-muted-foreground">
                    Standard roles for your DSP. All roles currently have the
                    same permissions.
                  </p>
                </div>
                <div className="role-list">
                  {data.roles.map((r) => (
                    <section key={r.id} className="role-row">
                      <div>
                        <div className="flex items-center gap-3">
                          <h2>{r.name}</h2>
                          <span className="text-xs text-muted-foreground">
                            Standard role
                          </span>
                        </div>
                        <p>{r.description}</p>
                      </div>
                    </section>
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="invitations">
                <div className="table-toolbar">
                  <p className="text-sm text-muted-foreground">
                    Pending invitations to your DSP.
                  </p>
                  <RefreshButton
                    onClick={() => void team.refetch()}
                    busy={team.isFetching}
                  />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email address</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invites.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>{i.email}</TableCell>
                        <TableCell>{i.roleName}</TableCell>
                        <TableCell>{dateTime(i.expiresAt, timeZone)}</TableCell>
                        <TableCell className="text-right">
                          {has(membership, "members.invite") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Revoke invitation for ${i.email}`}
                              onClick={() =>
                                setConfirm({
                                  title: "Revoke invitation",
                                  description: `Revoke the invitation for ${i.email}?`,
                                  path: `/api/organization/invitations/${i.id}`,
                                })
                              }
                            >
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!invites.length && (
                  <EmptyState
                    title="No pending invitations"
                    description="New invitations will appear here until they’re accepted."
                  />
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </>
      )}
      <Panel
        open={Boolean(editor)}
        onClose={() => setEditor(null)}
        title={editor?.kind === "invite" ? "Invite member" : "Change role"}
        description={
          editor?.kind === "member"
            ? `Update the role for ${editor.member.user.name}.`
            : "Send an invitation to join your DSP."
        }
        busy={busy}
      >
        {editor && (
          <form
            key={editor.kind === "member" ? editor.member.id : "invite"}
            onSubmit={submit}
            className="panel-form"
          >
            <FieldGroup>
              {editor.kind === "invite" && (
                <TextField
                  label="Email address"
                  name="email"
                  type="email"
                  autoComplete="off"
                  required
                  disabled={busy}
                />
              )}{" "}
              <Field>
                <FieldLabel htmlFor="editor-role">Role</FieldLabel>
                <NativeSelect
                  id="editor-role"
                  name="roleId"
                  defaultValue={
                    editor.kind === "member"
                      ? editor.member.role.id
                      : roles.find((role) => role.key === "driver")?.id
                  }
                  disabled={busy}
                  required
                >
                  {roles.map((r) => (
                    <NativeSelectOption value={r.id} key={r.id}>
                      {r.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <ErrorNotice error={error} />
            </FieldGroup>
            <div className="panel-footer">
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
              <SubmitButton busy={busy}>
                {editor.kind === "invite" ? "Send invitation" : "Save role"}
              </SubmitButton>
            </div>
          </form>
        )}
      </Panel>
      {confirm && (
        <ConfirmAction
          title={confirm.title}
          description={confirm.description}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await mutation(confirm.path, "DELETE", {});
            await team.refetch();
          }}
        />
      )}
    </>
  );
}
