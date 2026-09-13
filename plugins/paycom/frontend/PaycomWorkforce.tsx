import { usePaycomSync } from "./usePaycomSync.ts";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import {
  activeMembership,
  ApiError,
  has,
  request,
  isDspOwner,
  usePluginSettings,
} from "dispatch-sdk/ui";
import type { PaycomPreferences } from "./PaycomSettings.tsx";
import { useSession } from "dispatch-sdk/ui";
import { useTimezone, useBusinessToday } from "dispatch-sdk/ui";
import {
  calendarDateLabel as dateLabel,
  moveCalendarDate as moveDate,
  dateTime as timestamp,
} from "dispatch-sdk/ui";
import { Button } from "dispatch-sdk/ui";
import { Badge } from "dispatch-sdk/ui";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "dispatch-sdk/ui";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "dispatch-sdk/ui";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  Notice,
  PageHeading,
  TextField,
} from "dispatch-sdk/ui";
import "./paycom-workforce.css";

type PunchKey = "inDay" | "outLunch" | "inLunch" | "outDay";
type SortKey = "employeeName" | PunchKey | "totalHours" | "condition";
type Direction = "asc" | "desc";
type Punch = { time: string; timeBasis: "actual" | "displayed" };
type DayRow = {
  employeeCode: string;
  employeeName: string;
  businessDate: string;
  condition: "complete" | "incomplete" | "needs_review" | "no_activity";
  missingPunch: boolean;
  totalHours: string | null;
  observedAt: string;
  punches: Record<PunchKey | "unclassified", Punch[]>;
};
type Day = {
  available: boolean;
  items: DayRow[];
  total: number;
  offset: number;
  hasMore: boolean;
  businessDate: string;
  businessTimezone: string;
  collectedAt: string;
  periodStart: string;
  periodEnd: string;
};
type Employee = {
  employeeCode: string;
  employeeName: string;
  lifecycleStatus: string;
  department: { code: string; name: string };
  deliveryStation: { code: string; name: string };
  positionTitle: string;
  payClass: string;
  payType: string;
  primarySupervisor: string;
};
type Directory = {
  items: Employee[];
  target: string;
  collectedAt: string;
  total: number;
  hasMore: boolean;
};
type EmployeeDetail = {
  employee: Employee;
  days?: DayRow[];
  collectedAt: string;
  timecard: null | {
    periodStart: string;
    periodEnd: string;
    periodTotalHours: string;
    missingDays: number;
    canonicalUrl: string;
    observedAt: string;
  };
};
const columns: { key: SortKey; label: string }[] = [
  { key: "employeeName", label: "Employee" },
  { key: "inDay", label: "Clock in" },
  { key: "outLunch", label: "Lunch out" },
  { key: "inLunch", label: "Lunch in" },
  { key: "outDay", label: "Clock out" },
  { key: "totalHours", label: "Hours" },
  { key: "condition", label: "Punch status" },
];
const punchKeys: PunchKey[] = ["inDay", "outLunch", "inLunch", "outDay"];
function awaitingCollection(error: unknown) {
  return error instanceof ApiError && error.code === "not_initialized";
}
function AwaitingCollection() {
  return (
    <EmptyState
      title="Waiting for the first Paycom collection"
      description="Timecards and employees will appear here after the first collection finishes."
    />
  );
}
const nameOrder = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});
function status(row: DayRow) {
  if (row.missingPunch) return "Missing punch";
  if (row.condition === "needs_review") return "Needs review";
  if (row.condition === "no_activity") return "No punches";
  if (row.condition === "complete") return "Clocked out";
  return row.punches.outLunch.length > row.punches.inLunch.length
    ? "On lunch"
    : "Clocked in";
}
function punchTime(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}
function PunchCells({
  row,
  visible = [...punchKeys, "totalHours", "condition"],
}: {
  row: DayRow;
  visible?: string[];
}) {
  return (
    <>
      {visible.map((column) =>
        punchKeys.includes(column as PunchKey) ? (
          (() => {
            const key = column as PunchKey;
            return (
              <TableCell key={key}>
                <div className="paycom-punches">
                  {row.punches[key].length
                    ? row.punches[key].map((punch, index) => (
                        <span key={index}>
                          {punchTime(punch.time)}
                          <span className="sr-only">
                            {" "}
                            {punch.timeBasis} time
                          </span>
                        </span>
                      ))
                    : "—"}
                </div>
              </TableCell>
            );
          })()
        ) : column === "totalHours" ? (
          <TableCell key={column}>
            {row.totalHours === null ? "—" : Number(row.totalHours).toFixed(2)}
          </TableCell>
        ) : column === "condition" ? (
          <TableCell key={column}>
            <Badge
              variant={
                row.condition === "needs_review" ? "outline" : "secondary"
              }
            >
              {status(row)}
            </Badge>
            {row.punches.unclassified.length > 0 && (
              <div className="paycom-source-note">
                Unclassified:{" "}
                {row.punches.unclassified
                  .map((p) => punchTime(p.time))
                  .join(", ")}
              </div>
            )}
          </TableCell>
        ) : null,
      )}
    </>
  );
}
function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: Direction;
  onClick: () => void;
}) {
  const Icon = active
    ? direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;
  return (
    <TableHead
      scope="col"
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        aria-label={`Sort ${label} ${active && direction === "asc" ? "descending" : "ascending"}`}
      >
        {label}
        <Icon data-icon="inline-end" aria-hidden="true" />
      </Button>
    </TableHead>
  );
}
async function allEmployees(signal: AbortSignal) {
  const items: Employee[] = [];
  let first: Directory | undefined;
  // Bound the complete directory to the collector's 5,000-employee limit.
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await request<Directory>(
      `/api/paycom/employees?limit=100&offset=${offset}`,
      { signal },
    );
    if (
      first &&
      (page.target !== first.target ||
        page.collectedAt !== first.collectedAt ||
        page.total !== first.total)
    )
      throw new ApiError("workforce_changed");
    first ||= page;
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.items.length !== 100) throw new ApiError("workforce_unavailable");
  }
  throw new ApiError("workforce_unavailable");
}
function DailyTimecards({
  scope,
  timezone,
  displayTimezone,
  preferences,
}: {
  scope: string;
  timezone: string;
  displayTimezone: string;
  preferences: PaycomPreferences;
}) {
  const today = useBusinessToday(timezone);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>(preferences.default_sort);
  const [direction, setDirection] = useState<Direction>("asc");
  const [offset, setOffset] = useState(0);
  const date = selectedDate || today;
  const size = preferences.rows_per_page;
  const visibleColumns = [
    columns[0],
    ...preferences.columns
      .map((key) => columns.find((column) => column.key === key))
      .filter((column): column is (typeof columns)[number] => !!column),
  ];
  const filters = new URLSearchParams();
  if (preferences.department) filters.set("department", preferences.department);
  if (preferences.station) filters.set("station", preferences.station);
  const dayQuery = useQuery({
    queryKey: [
      "paycom-day",
      scope,
      date,
      sort,
      direction,
      offset,
      size,
      preferences.driver_departments,
      preferences.name_order,
      filters.toString(),
    ],
    queryFn: ({ signal }) =>
      request<{ day: Day }>(
        `/api/paycom/daily?date=${date}&sort=${sort}&direction=${direction}&limit=${size}&offset=${offset}&${filters}`,
        { signal },
      ),
    refetchInterval: date === today ? 30_000 : false,
  });
  const day = dayQuery.data?.day;
  const waiting = awaitingCollection(dayQuery.error);
  const chooseDate = (value: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today) {
      setSelectedDate(value === today ? null : value);
      setOffset(0);
    }
  };
  const changeSort = (key: SortKey) => {
    setDirection(sort === key && direction === "asc" ? "desc" : "asc");
    setSort(key);
    setOffset(0);
  };
  return (
    <div className="paycom-data-view">
      <div className="paycom-day-toolbar">
        <div>
          <h2>{date === today ? "Today’s timecards" : "Daily timecards"}</h2>
          <p className="paycom-source-note">
            {dateLabel(date)} · {timezone.replaceAll("_", " ")}
          </p>
        </div>
        <div className="paycom-date-controls">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous day"
            onClick={() => chooseDate(moveDate(date, -1))}
          >
            <ChevronLeft />
          </Button>
          <TextField
            label="Date"
            type="date"
            value={date}
            max={today}
            onChange={(event) => chooseDate(event.target.value)}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Next day"
            disabled={date >= today}
            onClick={() => chooseDate(moveDate(date, 1))}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            disabled={date === today}
            onClick={() => chooseDate(today)}
          >
            Today
          </Button>
        </div>
      </div>
      <ErrorNotice error={waiting ? null : dayQuery.error} />
      {dayQuery.isError && !waiting && (
        <Button variant="outline" onClick={() => dayQuery.refetch()}>
          Retry timecards
        </Button>
      )}
      {waiting ? (
        <AwaitingCollection />
      ) : dayQuery.isPending ? (
        <Loading />
      ) : (
        day && (
          <>
            {!day.available ? (
              <EmptyState
                title="No saved timecards for this date"
                description="Choose another day. Historical timecards are available for periods that have been collected."
              />
            ) : (
              <div className="paycom-data-table">
                <div className="paycom-table-heading">
                  <h2>Employee timecards</h2>
                  <span>{day.total} employees</span>
                </div>
                <Table aria-label="Daily employee timecards">
                  <TableHeader>
                    <TableRow>
                      {visibleColumns.map((column) => (
                        <SortHeader
                          key={column.key}
                          label={column.label}
                          active={sort === column.key}
                          direction={direction}
                          onClick={() => changeSort(column.key)}
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {day.items.map((row) => (
                      <TableRow key={row.employeeCode}>
                        <TableCell>{row.employeeName}</TableCell>
                        <PunchCells row={row} visible={preferences.columns} />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {day.items.length === 0 && (
                  <EmptyState
                    title={
                      preferences.driver_departments?.length === 0
                        ? "No driver departments selected"
                        : "No employees match your Timecard settings"
                    }
                    description="Your DSP owner can choose which departments appear in Paycom settings."
                  />
                )}
                {(offset > 0 || day.hasMore) && (
                  <div className="paycom-pagination">
                    <span>
                      {offset + 1}–{offset + day.items.length} of {day.total}
                    </span>
                    <Button
                      variant="outline"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - size))}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!day.hasMore}
                      onClick={() => setOffset(offset + size)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </div>
            )}
            <p className="paycom-source-note">
              Last collected {timestamp(day.collectedAt, displayTimezone)}.
              Times reflect the last collection, and hours may change after
              corrections.
            </p>
            <p className="paycom-source-note">
              An open shift or empty punch does not automatically mean a missing
              punch. Multiple punches are shown in source order; sorting uses
              the first punch.
            </p>
          </>
        )
      )}
    </div>
  );
}
function EmployeeTimecard({
  code,
  scope,
  timezone,
  back,
  nameOrder,
}: {
  code: string;
  scope: string;
  timezone: string;
  back: () => void;
  nameOrder: PaycomPreferences["name_order"];
}) {
  const detail = useQuery({
    queryKey: ["paycom-employee", scope, code, nameOrder],
    queryFn: ({ signal }) =>
      request<EmployeeDetail>(
        `/api/paycom/employees/${encodeURIComponent(code)}`,
        { signal },
      ),
  });
  const data = detail.data;
  return (
    <div className="paycom-data-view">
      <Button variant="ghost" onClick={back}>
        <ArrowLeft data-icon="inline-start" />
        Back to employees
      </Button>
      <ErrorNotice error={detail.error} />
      {detail.isError && (
        <Button variant="outline" onClick={() => detail.refetch()}>
          Retry employee
        </Button>
      )}
      {detail.isPending ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="paycom-day-toolbar">
              <div>
                <h2>{data.employee.employeeName}</h2>
                <p className="paycom-source-note">
                  {data.employee.positionTitle}
                </p>
              </div>
              <Badge variant="secondary">{data.employee.lifecycleStatus}</Badge>
            </div>
            <dl className="paycom-employee-details">
              {[
                ["Department", data.employee.department.name],
                ["Delivery station", data.employee.deliveryStation.code],
                ["Supervisor", data.employee.primarySupervisor],
                ["Pay class", data.employee.payClass],
                ["Pay type", data.employee.payType],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
            {data.employee.lifecycleStatus === "unknown" && (
              <Notice>
                Not present in the latest active roster. Last verified
                information is retained.
              </Notice>
            )}
            {data.timecard ? (
              <>
                <div className="paycom-day-toolbar">
                  <div>
                    <h2>Employee timecard</h2>
                    <p className="paycom-source-note">
                      {dateLabel(data.timecard.periodStart)} –{" "}
                      {dateLabel(data.timecard.periodEnd)}
                    </p>
                  </div>
                  <Button asChild variant="outline">
                    <a
                      href={data.timecard.canonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Paycom
                      <ExternalLink data-icon="inline-end" />
                    </a>
                  </Button>
                </div>
                {data.days?.length ? (
                  <div className="paycom-data-table">
                    <Table aria-label="Employee period timecard">
                      <TableHeader>
                        <TableRow>
                          {[
                            "Date",
                            ...columns.slice(1).map((c) => c.label),
                          ].map((label) => (
                            <TableHead scope="col" key={label}>
                              {label}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.days.map((row) => (
                          <TableRow key={row.businessDate}>
                            <TableCell>{dateLabel(row.businessDate)}</TableCell>
                            <PunchCells row={row} />
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <Notice>
                    Detailed daily rows are unavailable. Open the collected
                    period in Paycom.
                  </Notice>
                )}
                <p>
                  Period hours:{" "}
                  <strong>
                    {Number(data.timecard.periodTotalHours).toFixed(2)}
                  </strong>{" "}
                  · Days with missing punches: {data.timecard.missingDays}
                </p>
                <p className="paycom-source-note">
                  Last observed {timestamp(data.timecard.observedAt, timezone)}.
                  Blank days indicate no recorded activity, not an absence.
                </p>
              </>
            ) : (
              <EmptyState title="No collected timecard for this employee" />
            )}
          </>
        )
      )}
    </div>
  );
}
function Employees({
  scope,
  timezone,
  preferences,
}: {
  scope: string;
  timezone: string;
  preferences: PaycomPreferences;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("asc");
  const employees = useQuery({
    queryKey: ["paycom-employees", scope, preferences.name_order],
    queryFn: ({ signal }) => allEmployees(signal),
    refetchInterval: (query) =>
      awaitingCollection(query.state.error) ? 30_000 : false,
  });
  const waiting = awaitingCollection(employees.error);
  const size = preferences.rows_per_page;
  const rows = (employees.data || [])
    .filter(
      (row) =>
        (!preferences.department ||
          row.department.code === preferences.department) &&
        (!preferences.station ||
          row.deliveryStation.code === preferences.station),
    )
    .filter((row) =>
      row.employeeName
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        nameOrder.compare(a.employeeName, b.employeeName) *
          (direction === "asc" ? 1 : -1) ||
        a.employeeCode.localeCompare(b.employeeCode),
    );
  if (selected)
    return (
      <EmployeeTimecard
        code={selected}
        scope={scope}
        timezone={timezone}
        back={() => setSelected(null)}
        nameOrder={preferences.name_order}
      />
    );
  return (
    <div className="paycom-data-view">
      <div className="paycom-employee-search">
        <TextField
          label="Find employee"
          type="search"
          placeholder="Search by name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </div>
      <ErrorNotice error={waiting ? null : employees.error} />
      {employees.isError && !waiting && (
        <Button variant="outline" onClick={() => employees.refetch()}>
          Retry employees
        </Button>
      )}
      {waiting ? (
        <AwaitingCollection />
      ) : employees.isPending ? (
        <Loading />
      ) : (
        !employees.isError && (
          <div className="paycom-data-table">
            <div className="paycom-table-heading">
              <h2>Employees</h2>
              <span>
                {rows.length} {rows.length === 1 ? "employee" : "employees"}
              </span>
            </div>
            <Table aria-label="Employee directory">
              <TableHeader>
                <TableRow>
                  <SortHeader
                    label="Employee"
                    active
                    direction={direction}
                    onClick={() => {
                      setDirection(direction === "asc" ? "desc" : "asc");
                      setPage(0);
                    }}
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(page * size, (page + 1) * size).map((row) => (
                  <TableRow key={row.employeeCode}>
                    <TableCell>
                      <Button
                        variant="link"
                        onClick={() => setSelected(row.employeeCode)}
                      >
                        {row.employeeName}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length > size && (
              <div className="paycom-pagination">
                <span>
                  {page * size + 1}–{Math.min((page + 1) * size, rows.length)}{" "}
                  of {rows.length}
                </span>
                <Button
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={(page + 1) * size >= rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
            {rows.length === 0 && (
              <EmptyState
                title={
                  search ? "No matching employees" : "No collected employees"
                }
                description={search ? "Try another name." : undefined}
              />
            )}
          </div>
        )
      )}
    </div>
  );
}
const syncLabels: Record<string, string> = {
  idle: "Waiting for next sync",
  queued: "Queued",
  waiting_for_capacity: "Waiting for capacity",
  syncing: "Collecting",
  stopping: "Stopping",
  backing_off: "Waiting to retry",
  blocked: "Needs attention",
};
function PaycomSyncStatus({
  scope,
  timezone,
  canSync,
}: {
  scope: string;
  timezone: string;
  canSync: boolean;
}) {
  const { query, run, busy, authentication, message } = usePaycomSync(scope);
  const sync = query.data;
  const label = query.isError
    ? "Sync status unavailable"
    : !sync
      ? "Checking sync status"
      : sync.queuedRequest?.status === "failed"
        ? "Requested sync could not start"
        : busy
          ? syncLabels[sync.activity]
          : authentication
            ? "Needs authentication"
            : sync.desiredState === "stopped" && sync.activity !== "stopping"
              ? "Sync paused"
              : sync.activity === "idle" && sync.lastError
                ? "Last collection failed"
                : sync.activity === "idle" && !sync.lastSucceededAt
                  ? "Waiting for first collection"
                  : syncLabels[sync.activity] || "Needs attention";
  return (
    <div
      className="paycom-sync-status"
      role="status"
      aria-label="Paycom sync"
      aria-live="polite"
    >
      <span>{label}</span>
      {sync?.lastSucceededAt ? (
        <span className="text-muted-foreground">
          Last successful sync {timestamp(sync.lastSucceededAt, timezone)}
        </span>
      ) : null}
      {sync?.desiredState === "running" && sync.nextDueAt && !authentication ? (
        <span className="text-muted-foreground">
          Next scheduled sync {timestamp(sync.nextDueAt, timezone)}
        </span>
      ) : null}
      {canSync ? (
        <Button variant="outline" onClick={() => run.mutate()}>
          Sync now
        </Button>
      ) : null}
      {authentication ? (
        <Notice>
          Click Sync now to sign in to Paycom and sync your data.
          {sync?.lastSucceededAt
            ? " Previously synced data remains available below."
            : " Workforce data will appear after verification and the first successful sync."}
        </Notice>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      {run.isError ? (
        <Notice>Could not request a sync. Please try again.</Notice>
      ) : null}
    </div>
  );
}

export function PaycomWorkforce({
  setupNotice,
}: { setupNotice?: ReactNode } = {}) {
  const { session } = useSession();
  const { timeZone: displayTimezone } = useTimezone();
  const membership = activeMembership(session);
  const settings = usePluginSettings<PaycomPreferences>("paycom");
  if (!has(membership, "workforce.read"))
    return <Notice>You do not have permission to view workforce data.</Notice>;
  const scope = `${membership!.organizationId}:${session?.dspView?.viewRef || "member"}`;
  const timezone = membership!.organization.timezone;
  if (settings.query.isPending) return <Loading />;
  if (!settings.query.data)
    return (
      <>
        <ErrorNotice error={settings.query.error} />
        <Button onClick={() => void settings.query.refetch()}>
          Retry Paycom settings
        </Button>
      </>
    );
  const preferences = settings.query.data.values;
  return (
    <div className="paycom-workforce">
      <PageHeading
        title="Paycom"
        description="Daily timecards and employee records."
      />
      {isDspOwner(session) && (
        <Button
          variant="outline"
          className="self-end"
          onClick={() => {
            location.hash = "#/paycom?settings";
          }}
        >
          Paycom settings
        </Button>
      )}
      {setupNotice || (
        <PaycomSyncStatus
          key={scope}
          scope={scope}
          timezone={displayTimezone}
          canSync={has(membership, "sync.run")}
        />
      )}
      <Tabs
        defaultValue={
          preferences.opening_page === "employees" ? "employees" : "timecard"
        }
        key={`${scope}:${settings.query.data.revision}`}
      >
        <TabsList variant="line" aria-label="Paycom pages">
          <TabsTrigger value="timecard">Timecard</TabsTrigger>
          <TabsTrigger value="employees">Employees</TabsTrigger>
        </TabsList>
        <TabsContent value="timecard">
          <DailyTimecards
            scope={scope}
            timezone={timezone}
            displayTimezone={displayTimezone}
            preferences={preferences}
          />
        </TabsContent>
        <TabsContent value="employees">
          <Employees
            scope={scope}
            timezone={displayTimezone}
            preferences={preferences}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
