import { navigate, signInHash } from './navigation.js';

type SignInHandoff = { email: string; animate: boolean };
let pending: SignInHandoff | undefined;

/** Ephemeral navigation data only; creating a profile never establishes a session. */
export function signInAfterProfile(email: string, animate = false) {
  pending = { email, animate };
  navigate(signInHash);
}

// Read without consuming during render, including React's repeated initial renders.
export const getSignInHandoff = () => pending;
export function clearSignInHandoff() {
  pending = undefined;
}
