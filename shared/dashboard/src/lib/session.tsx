import { createContext, useContext } from "react";
import type { Session } from "./types.ts";
export const SessionContext = createContext<{
  session: Session;
  refresh: (session?: Session) => Promise<void>;
} | null>(null);
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw Error("Session required");
  return value;
}
