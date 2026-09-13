// Stable dashboard SDK host. Installed frontends use these existing providers
// and controls instead of bundling a second session/query context.
export { activeMembership, ApiError, has, idempotent, isDspOwner, mutation, request } from "../lib/api.ts";
export { useSession } from "../lib/session.tsx";
export { useTimezone, useBusinessToday } from "../lib/timezone.tsx";
export { calendarDateLabel, moveCalendarDate, dateTime } from "../lib/date-time.ts";
export { Button } from "../components/ui/button.tsx";
export { Badge } from "../components/ui/badge.tsx";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs.tsx";
export { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from "../components/ui/table.tsx";
export { EmptyState, ErrorNotice, Loading, Notice, PageHeading, TextField } from "../components/shared.tsx";
export { usePluginSettings, PluginSettingsField, PluginSettingsForm } from "./settings.tsx";

export { invokePluginOperation } from './operations.ts';
