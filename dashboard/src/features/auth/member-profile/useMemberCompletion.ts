import { useEffect, useRef } from 'react';

import { MEMBER_COMPLETION_MEDIA } from './member-completion-motion.js';
type CompletionModule = typeof import('./MemberProfileCompletion.js');

/** Preload only on eligible desktops. A failed or slow decoration must never block sign-in. */
export function useMemberCompletion() {
  const module = useRef<CompletionModule | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const media = matchMedia(MEMBER_COMPLETION_MEDIA);
    const preload = () => {
      if (media.matches && !module.current)
        void import('./MemberProfileCompletion.js').then(
          (loaded) => {
            if (mounted.current) module.current = loaded;
          },
          () => {},
        );
    };
    preload();
    media.addEventListener('change', preload);
    return () => {
      mounted.current = false;
      media.removeEventListener('change', preload);
    };
  }, []);
  return { module, mounted };
}
