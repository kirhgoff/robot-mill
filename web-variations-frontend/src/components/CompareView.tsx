import type { Variation } from "../api/client";
import { CompareCell } from "./CompareCell";
import { EmptyState } from "./ui/EmptyState";

interface Props {
	variations: Variation[];
}

export function CompareView({ variations }: Props) {
	const running = variations.filter((v) => v.status === "running" && v.port);

	if (running.length === 0) {
		return (
			<EmptyState
				icon="🔍"
				title="No running variations to compare"
				subtitle="Start at least two variations to compare them side by side"
			/>
		);
	}

	return (
		<div className="compare-grid">
			{running.map((v) => (
				<CompareCell key={v.id} variation={v} />
			))}
		</div>
	);
}
