import type { PropsWithChildren } from "react";

export function Card({
  children,
  className = "",
}: PropsWithChildren<{ className?: string }>) {
  return (
    <div className={`bg-base-900 border border-base-800 rounded-xl2 shadow-card ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between px-5 pt-5 pb-3">
      <div>
        <h2 className="text-sm font-semibold text-base-100">{title}</h2>
        {subtitle && <p className="text-xs text-base-400 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
