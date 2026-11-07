import { type ReactNode } from 'react';
import { money } from '../../shared/schema';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Token({ className = '' }: { className?: string }) {
  return (
    <span className={`token ${className}`} aria-label="Accord test token">
      $
    </span>
  );
}

export function Metric({
  label,
  amount,
  caption,
  icon,
  accent = false,
}: {
  label: string;
  amount: string;
  caption: string;
  icon: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <div className="metric-value">
        {money(amount)}
        <span>aUSD</span>
      </div>
      <p>{caption}</p>
    </div>
  );
}
