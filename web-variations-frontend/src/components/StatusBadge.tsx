import type { Variation } from "../api/client";

interface Props {
	status: Variation["status"];
}

export function StatusBadge({ status }: Props) {
	return (
		<span className={`badge badge-${status}`}>
			<span className={`status-dot ${status}`} />
			{status}
		</span>
	);
}
