import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { messageOf } from '../lib/errors.js';
import { ErrorBox } from '../ui.js';

type Feedback = {
  error: string;
  notice: string;
  /** Runs `work`, then toasts `success` or shows why it failed at the top of the page. */
  perform: (work: () => Promise<unknown>, success?: string) => Promise<boolean>;
  notify: (notice: string) => void;
  fail: (error: string) => void;
};
const Context = createContext<Feedback | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, notify] = useState(''),
    [error, fail] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => notify(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const perform = useCallback<Feedback['perform']>(async (work, success) => {
    fail('');
    try {
      await work();
      if (success) notify(success);
      return true;
    } catch (error) {
      fail(messageOf(error));
      return false;
    }
  }, []);
  const value = useMemo(() => ({ error, notice, perform, notify, fail }), [error, notice, perform]);
  return <Context value={value}>{children}</Context>;
}

export function useFeedback() {
  const feedback = useContext(Context);
  if (!feedback) throw new Error('useFeedback needs a FeedbackProvider');
  return feedback;
}

/** Where the page shows the app-level error and toast. */
export function FeedbackMessages() {
  const { error, notice, notify } = useFeedback();
  return (
    <>
      <ErrorBox message={error} />
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="Dismiss notification" onClick={() => notify('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
