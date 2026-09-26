import { api } from './api.js';

function supported() {
  if (!window.isSecureContext || !window.PublicKeyCredential?.parseCreationOptionsFromJSON)
    throw new Error('Passkeys need a current browser and an HTTPS connection.');
}

export async function registerPasskey(name: string): Promise<string[]> {
  supported();
  const options = await api<{ publicKey: PublicKeyCredentialCreationOptionsJSON }>(
    '/api/auth/security/passkeys/register/start',
    {},
  );
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error('Passkey registration was cancelled.');
  const result = await api<{ codes: string[] }>('/api/auth/security/passkeys/register/finish', {
    name,
    credential: credential.toJSON(),
  });
  return result.codes;
}

export async function verifyPasskey() {
  supported();
  const options = await api<{ publicKey: PublicKeyCredentialRequestOptionsJSON }>(
    '/api/auth/security/passkeys/verify/start',
    {},
  );
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey),
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error('Passkey verification was cancelled.');
  await api('/api/auth/security/passkeys/verify/finish', { credential: credential.toJSON() });
}
