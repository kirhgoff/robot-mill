import type { ReactNode } from "react";

interface Props {
	label: string;
	children: ReactNode;
}

export function FormField({ label, children }: Props) {
	return (
		<div className="form-group">
			<label>{label}</label>
			{children}
		</div>
	);
}
