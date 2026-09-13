import { useQuery } from "@tanstack/react-query";
import { activeMembership, has, request } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useTimezone } from "@/lib/timezone";
import type { AuditLogData } from "@/lib/types";
import {
  dateTime,
  EmptyState,
  ErrorNotice,
  Loading,
  Notice,
  RefreshButton,
  Status,
} from "@/components/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function AuditLog() {
  const { session } = useSession();
  const { timeZone } = useTimezone();
  const membership = activeMembership(session);
  const suspended = membership?.organization.status === "suspended";
  const audit = useQuery({
    queryKey: ["organization-audit", membership?.organizationId],
    queryFn: ({ signal }) =>
      request<AuditLogData>("/api/organization/audit", { signal }),
    enabled: has(membership, "audit.read") && !suspended,
    refetchInterval: 15000,
  });

  if (suspended)
    return (
      <Notice>This DSP is suspended. The audit log is unavailable.</Notice>
    );
  if (!has(membership, "audit.read")) return null;

  return (
    <>
      <div className="table-toolbar">
        <p className="text-sm text-muted-foreground">
          Recent changes to your DSP, team, and access.
        </p>
        <RefreshButton
          onClick={() => void audit.refetch()}
          busy={audit.isFetching}
        />
      </div>
      <ErrorNotice error={audit.error} />
      {audit.isPending ? (
        <Loading />
      ) : audit.data && !audit.error ? (
        audit.data.audit.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.data.audit.map((event, index) => (
                <TableRow key={event.id || index}>
                  <TableCell>{event.action.replaceAll(".", " ")}</TableCell>
                  <TableCell>{event.actor}</TableCell>
                  <TableCell>{dateTime(event.createdAt, timeZone)}</TableCell>
                  <TableCell>
                    <Status value={event.result}>{event.result}</Status>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            title="No audit events yet"
            description="Changes to your DSP will appear here."
          />
        )
      ) : null}
    </>
  );
}
