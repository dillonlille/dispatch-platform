export function EmployeeAvatar({ name }: { name: string }) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const initials = words
    .slice(0, 2)
    .map((word) => [...word][0])
    .join('')
    .toLocaleUpperCase('en-US');
  return (
    <span className="employee-avatar" aria-hidden="true">
      {initials || '?'}
    </span>
  );
}
