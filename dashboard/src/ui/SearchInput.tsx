import { Search } from 'lucide-react';

export function SearchInput({
  label,
  placeholder,
  value,
  onChange,
  type,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'search';
}) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        type={type}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
