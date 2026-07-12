import { ReactNode } from "react";
import { createPortal } from "react-dom";

interface PortalProps {
  children: ReactNode;
  container?: Element;
}

export default function Portal({ children, container }: PortalProps) {
  const host = container ?? (typeof document !== "undefined" ? document.body : null);
  if (!host) return null;
  return createPortal(children, host);
}
