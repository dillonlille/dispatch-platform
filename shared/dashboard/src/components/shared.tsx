import { useTheme } from "@/lib/theme";
import type { PageHeadingProps } from "@/themes/types";
import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { RefreshCw, Search, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "./ui/sheet.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty.tsx";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import type { InvitationResult } from "@/lib/types";
export function PageHeading(props: PageHeadingProps) {
  const View =
    useTheme().themePack.components?.PageHeading || DefaultPageHeading;
  return <View {...props} />;
}
export function DefaultPageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function TextField({
  label,
  description,
  ...props
}: ComponentProps<typeof Input> & { label: string; description?: string }) {
  const id = useId();
  return (
    <Field data-disabled={props.disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} {...props} />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Alert
      variant={error ? "destructive" : "default"}
      role={error ? "alert" : "status"}
      className="my-4"
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? <Notice error>{errorMessage(error)}</Notice> : null;
}
export function Loading() {
  return (
    <div
      className="flex flex-col gap-5 py-8"
      role="status"
      aria-label="Loading"
    >
      <Skeleton className="h-6 w-48" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}
export function RefreshButton({
  onClick,
  busy = false,
}: {
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh"
      disabled={busy}
      onClick={onClick}
    >
      <RefreshCw
        data-icon="inline-start"
        className={cn(busy && "animate-spin")}
      />
    </Button>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-input">
      <Search aria-hidden="true" />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function SubmitButton({
  busy,
  children,
  ...props
}: ComponentProps<typeof Button> & { busy: boolean }) {
  return (
    <Button type="submit" disabled={busy} {...props}>
      {busy && (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      )}
      {children}
    </Button>
  );
}
export function Status({
  value,
  children,
}: {
  value: string;
  children?: ReactNode;
}) {
  return (
    <span className={cn("status", `status-${value.replaceAll("_", "-")}`)}>
      <span aria-hidden="true" />
      {children || value.replaceAll("_", " ")}
    </span>
  );
}
export function Panel({
  open,
  onClose,
  title,
  description,
  children,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: string;
  children: ReactNode;
  busy?: boolean;
}) {
  const prior = useRef<HTMLElement | null>(null);
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <SheetContent
        showCloseButton={!busy}
        onOpenAutoFocus={() => {
          prior.current = document.activeElement as HTMLElement;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (prior.current?.isConnected) prior.current.focus();
          else document.querySelector<HTMLElement>(".page-heading h1")?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {description || "Review details and manage access."}
          </SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
export function ConfirmAction({
  title,
  description,
  confirmation,
  passwordRequired = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmation?: string;
  passwordRequired?: boolean;
  onConfirm: (password?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (confirmation && text !== confirmation) return;
            setBusy(true);
            setError(null);
            try {
              await onConfirm(passwordRequired ? text : undefined);
              onClose();
            } catch (err) {
              if (passwordRequired) setText("");
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
          className="flex flex-col gap-5"
        >
          {passwordRequired && (
            <TextField
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              disabled={busy}
            />
          )}
          {confirmation && (
            <TextField
              label={`Type ${confirmation} to confirm`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              disabled={busy}
              required
            />
          )}
          <ErrorNotice error={error} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <SubmitButton
              busy={busy}
              variant="destructive"
              disabled={
                busy ||
                Boolean(confirmation && text !== confirmation) ||
                (passwordRequired && !text)
              }
            >
              {title}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function InvitationNotice({
  result,
}: {
  result: InvitationResult | null;
}) {
  if (!result) return null;
  const email =
    result.ownerInvitation?.email ||
    result.invitation?.email ||
    "the recipient";
  if (result.delivery?.status === "accepted")
    return <Notice>Invitation sent to {email}.</Notice>;
  if (!result.invitationPath)
    return (
      <Notice>
        The invitation request was already processed. No new invitation was
        sent.
      </Notice>
    );
  const url = new URL(result.invitationPath, window.location.origin).href;
  return (
    <Notice>
      <div className="flex flex-col gap-3">
        <p>
          {result.delivery?.status === "unknown"
            ? "Email delivery could not be confirmed. Use this same link if a private handoff is needed."
            : result.delivery?.status === "failed"
              ? "The invitation email could not be sent. Share this one-time invitation through a private channel."
              : "No email was sent because invitation email is not configured. Share this one-time invitation through a private channel."}
        </p>
        <Input
          aria-label="Invitation link"
          value={url}
          readOnly
          onFocus={(e) => e.target.select()}
        />
        <Button
          variant="outline"
          onClick={() => navigator.clipboard.writeText(url).catch(() => {})}
        >
          Copy link
        </Button>
      </div>
    </Notice>
  );
}
export { dateTime } from "@/lib/date-time";
