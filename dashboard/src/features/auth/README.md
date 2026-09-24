# Authentication screens

- `dsp-onboarding/` owns DSP setup, owner invitations, its forms, map and styles.
- `member-profile/` owns member invitations, profile creation, the completion lanyard and the
  pages for an expired or already-accepted invitation link.
- `sign-in/` owns sign-in, password recovery and its van artwork.

`AuthScreen` and `InvitationScreen` choose the screen. Screen directories never import
each other; `tests/dashboard/dashboard-structure.test.ts` enforces that boundary. Shared app and
UI primitives are allowed. Similar artwork is maintained separately by each screen.

Member profile acceptance creates the account without logging in. The only navigation
data sent to Sign In is an in-memory email and entrance flag in `app/sign-in-handoff.ts`.
Passwords are never passed to Sign In or persisted by this flow.

An invitation lookup answers `accepted: true` with the email, DSP name and role once the link
has been used, until the invitation's original seven days run out. It answers
`invitation_expired` when it expired, was revoked or never existed, and for a used link after
those seven days.
`InvitationScreen` shows `InvitationAccepted`, which hands its email to Sign In the same way,
or `InvitationExpired` for those; any other failure keeps the form with its error. Their map
settles instead of animating: `route` on `MemberProfileLayout` selects `live`, `cancelled` or
`delivered`.

For the desktop completion sequence, adjust `member-profile/member-completion-motion.ts`
for timing, `MemberProfileCompletion.tsx` for choreography and badge content,
`MemberProfileLanyard.tsx` for strap/clip artwork, and `member-profile-completion.css` for
card dimensions and materials. The module loads only above 700px with motion enabled.
Phones, reduced motion and failed artwork loads go directly to Sign In.
