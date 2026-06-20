import type { ReactNode } from "react";

interface Props {
	title: string;
	onClose: () => void;
	children: ReactNode;
}

export function Modal({ title, onClose, children }: Props) {
	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{title}</h2>
				{children}
			</div>
		</div>
	);
}
