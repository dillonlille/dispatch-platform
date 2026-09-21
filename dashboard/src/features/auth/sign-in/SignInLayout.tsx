import type { ReactNode } from 'react';
import { Brand } from '../../../app/Brand.js';
import { LoginArtwork } from './LoginArtwork.js';
import './sign-in.css';

export function SignInLayout({
  children,
  enter = false,
}: {
  children: ReactNode;
  enter?: boolean;
}) {
  return (
    <main className="auth-layout" data-enter={enter}>
      <LoginArtwork />
      <div className="auth-content">
        <div className="auth-brand">
          <Brand />
        </div>
        <span className="auth-annotation">MEMBER ACCESS</span>
        {children}
        <span className="auth-wordmark">Dispatch</span>
      </div>
    </main>
  );
}
