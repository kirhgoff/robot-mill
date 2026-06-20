import type { Variation } from "../api/client";
import { VariationCard } from "./VariationCard";
import { EmptyState } from "./ui/EmptyState";

interface Props {
	variations: Variation[];
	selectedId: string | null;
	actionLoading: string | null;
	showTabsSet: Set<string>;
	onSelect: (id: string) => void;
	onStart: (v: Variation) => void;
	onStop: (v: Variation) => void;
	onDelete: (v: Variation) => void;
	onPullRequest: (v: Variation) => void;
	onRefresh: (v: Variation) => void;
	onToggleTabs: (id: string) => void;
}

export function VariationList({
	variations,
	selectedId,
	actionLoading,
	showTabsSet,
	onSelect,
	onStart,
	onStop,
	onDelete,
	onPullRequest,
	onRefresh,
	onToggleTabs,
}: Props) {
	if (variations.length === 0) {
		return <EmptyState title="No variations yet. Click + to create one." compact />;
	}

	return (
		<div className="sidebar-list">
			{variations.map((v) => (
				<VariationCard
					key={v.id}
					variation={v}
					isSelected={v.id === selectedId}
					actionLoading={actionLoading}
					tabsVisible={showTabsSet.has(v.id)}
					onSelect={() => onSelect(v.id)}
					onStart={() => onStart(v)}
					onStop={() => onStop(v)}
					onDelete={() => onDelete(v)}
					onPullRequest={() => onPullRequest(v)}
					onRefresh={() => onRefresh(v)}
					onToggleTabs={() => onToggleTabs(v.id)}
				/>
			))}
		</div>
	);
}
