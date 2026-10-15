import type { ButtonHTMLAttributes, ReactNode } from "react";
export function Button({
  children,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger";
}) {
  return (
    <button {...props} className={`btn ${variant} ${props.className ?? ""}`}>
      {children}
    </button>
  );
}
export function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state.toLowerCase()}`}>
      {state.replaceAll("_", " ").toLowerCase()}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
