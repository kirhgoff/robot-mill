import type { ReactNode } from "react";

interface Props {
	children: ReactNode;
}

export function ModalActions({ children }: Props) {
	return <div className="modal-actions">{children}</div>;
}
