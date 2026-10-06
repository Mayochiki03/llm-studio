import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLS: Record<Variant, string> = {
  primary: "bg-accent-500 hover:bg-accent-400 text-base-950 font-medium shadow-card",
  secondary: "bg-base-800 hover:bg-base-700 text-base-100 border border-base-700",
  danger: "bg-bad/10 hover:bg-bad/20 text-bad border border-bad/30",
  ghost: "hover:bg-base-800 text-base-300 hover:text-base-100",
};

export default function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLS[variant]} ${className}`}
      {...props}
    />
  );
}
