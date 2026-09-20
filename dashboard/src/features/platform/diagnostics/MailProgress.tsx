import { CircleCheck, CircleDashed, CircleX, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MailMessage } from '../../../../../shared/contracts/index.js';
import { at, mailFailure } from './mail.js';

function Step({
  state,
  label,
  detail,
}: {
  state: 'done' | 'retrying' | 'failed' | 'todo';
  label: string;
  detail?: ReactNode;
}) {
  const [Icon, tone] = (
    {
      done: [CircleCheck, 'mail-step-done'],
      retrying: [RefreshCw, 'mail-step-retrying'],
      failed: [CircleX, 'mail-step-failed'],
      todo: [CircleDashed, 'mail-step-todo'],
    } as const
  )[state];
  return (
    <li className={`mail-step ${tone}`}>
      <Icon size={14} aria-hidden="true" />
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
    </li>
  );
}
/** A message's steps: delivery, then what the person did with an invitation. */
export function MailProgress({ message }: { message: MailMessage }) {
  const delivery =
    message.status === 'sent' ? (
      <Step state="done" label="Sent" detail={at(message.sentAt)} />
    ) : message.status === 'failed' ? (
      <Step
        state="failed"
        label="Not delivered"
        detail={mailFailure(message.lastError) || at(message.lastAttemptAt)}
      />
    ) : message.attempts ? (
      <Step
        state="retrying"
        label={`Retrying · attempt ${message.attempts + 1} of 5`}
        detail={`Next ${at(message.nextAttemptAt)}`}
      />
    ) : (
      <Step state="todo" label="Queued" detail={at(message.queuedAt)} />
    );
  const invitation = message.kind === 'invitation';
  return (
    <ol className="mail-steps">
      {delivery}
      {invitation && (
        <Step
          state={message.acceptedAt ? 'done' : 'todo'}
          label={message.owner ? 'Accepted' : 'Joined'}
          detail={message.acceptedAt ? at(message.acceptedAt) : undefined}
        />
      )}
      {invitation && message.owner && (
        <Step state={message.setupComplete ? 'done' : 'todo'} label="DSP set up" />
      )}
    </ol>
  );
}
