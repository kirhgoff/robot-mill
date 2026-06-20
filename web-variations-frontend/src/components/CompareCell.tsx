import type { Variation } from "../api/client";

interface Props {
	variation: Variation;
}

export function CompareCell({ variation }: Props) {
	const url = `${window.location.protocol}//${window.location.hostname}:${variation.port}`;
	return (
		<div className="compare-cell">
			<div className="compare-cell-header">
				<span>{variation.title}</span>
				<span style={{ color: "var(--text-muted)", fontSize: 12 }}>
					:{variation.port}
				</span>
			</div>
			<iframe src={url} title={`Compare: ${variation.title}`} />
		</div>
	);
}
