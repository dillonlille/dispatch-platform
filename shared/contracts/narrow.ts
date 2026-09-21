// A generated shape with some fields given the narrower type the backend really sends.
// The narrower type must fit the generated one, so a renamed or retyped field fails here.
export type Narrow<T, N extends { [K in keyof N]: K extends keyof T ? T[K] : never }> = Omit<
  T,
  keyof N
> &
  N;
