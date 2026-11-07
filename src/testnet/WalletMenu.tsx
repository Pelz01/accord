import { useRef, useState } from 'react';
import { ChevronDown, LogOut, Wallet } from 'lucide-react';

export function WalletMenu({
  account,
  busy,
  onDisconnect,
}: {
  account: string;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <details
      ref={ref}
      className="wallet-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && ref.current?.open) {
          ref.current.open = false;
          ref.current.querySelector('summary')?.focus();
          event.stopPropagation();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          event.currentTarget.open = false;
      }}
    >
      <summary role="button" aria-expanded={open} aria-label={`Wallet: ${account}`} title={account}>
        <Wallet size={16} />
        <span>{account}</span>
        <ChevronDown size={13} />
      </summary>
      <div className="wallet-menu-panel">
        <span>Connected wallet</span>
        <p>{account}</p>
        <button disabled={busy} onClick={onDisconnect}>
          <LogOut size={15} />
          Disconnect
        </button>
      </div>
    </details>
  );
}
