import type { ComponentType, ReactNode } from "react";

export type Appearance = "light" | "dark" | "system";
export type ResolvedAppearance = Exclude<Appearance, "system">;
export interface PageHeadingProps {
  title: string;
  description?: string;
  children?: ReactNode;
}
export interface ShellLayoutProps {
  navigation: ReactNode;
  mobileNavigation: ReactNode;
  banner: ReactNode;
  header: ReactNode;
  children: ReactNode;
}
export interface ThemePack {
  apiVersion: 1;
  id: string;
  name: string;
  description: string;
  components?: {
    ShellLayout?: ComponentType<ShellLayoutProps>;
    PageHeading?: ComponentType<PageHeadingProps>;
    DspAvatar?: ComponentType<{ name: string }>;
  };
}

export function defineTheme(pack: ThemePack): ThemePack {
  if (pack.apiVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(pack.id)) {
    throw new Error(`Invalid theme pack: ${pack.id}`);
  }
  return pack;
}
