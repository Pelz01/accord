import { useRef } from 'react';
import { ChevronDown, Download } from 'lucide-react';

export function downloadCSV(filename: string, contents: string) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[^a-zA-Z0-9_.-]/g, '-');
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Exports({
  options,
}: {
  options: { label: string; filename: string; contents: () => string; disabled?: boolean }[];
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details
      className="export-menu"
      ref={menu}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          menu.current?.removeAttribute('open');
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          menu.current?.removeAttribute('open');
          menu.current?.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className="button secondary">
        <Download size={15} />
        Export CSV
        <ChevronDown size={13} />
      </summary>
      <div className="export-options" role="group" aria-label="CSV exports">
        {options.map((option) => (
          <button
            key={option.label}
            disabled={option.disabled}
            onClick={() => {
              downloadCSV(option.filename, option.contents());
              menu.current?.removeAttribute('open');
            }}
          >
            {option.label}
            <Download size={13} />
          </button>
        ))}
      </div>
    </details>
  );
}
