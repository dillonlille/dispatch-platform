import { useTheme } from "@/lib/theme";
import { dspIdentity } from "@/lib/identity";

export function DefaultDspAvatar({ name }: { name: string }) {
  const { initials, className } = dspIdentity(name);
  return (
    <span aria-hidden="true" className={className}>
      {initials}
    </span>
  );
}

export function DspAvatar(props: { name: string }) {
  const View = useTheme().themePack.components?.DspAvatar || DefaultDspAvatar;
  return <View {...props} />;
}
