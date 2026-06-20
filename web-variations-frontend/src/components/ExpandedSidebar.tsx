import type { Variation } from "../api/client";
import { VariationList } from "./VariationList";

interface Props {
	variations: Variation[];
	selectedId: string | null;
	actionLoading: string | null;
	showTabsSet: Set<string>;
	onCollapse: () => void;
	onSettings: () => void;
	onNew: () => void;
	onSelect: (id: string) => void;
	onStart: (v: Variation) => void;
	onStop: (v: Variation) => void;
	onDelete: (v: Variation) => void;
	onPullRequest: (v: Variation) => void;
	onRefresh: (v: Variation) => void;
	onToggleTabs: (id: string) => void;
}

export function ExpandedSidebar({
	variations,
	selectedId,
	actionLoading,
	showTabsSet,
	onCollapse,
	onSettings,
	onNew,
	onSelect,
	onStart,
	onStop,
	onDelete,
	onPullRequest,
	onRefresh,
	onToggleTabs,
}: Props) {
	return (
		<div className="sidebar">
			<div className="sidebar-header">
				<h1>{import.meta.env.VITE_APP_TITLE ?? "✦ Vary"}</h1>
				<div style={{ display: "flex", gap: 6 }}>
					<button
						className="btn btn-sm"
						onClick={onCollapse}
						title="Collapse sidebar"
					>
						‹
					</button>
					<button
						className="btn btn-sm"
						onClick={onSettings}
						title="Settings"
					>
						⚙
					</button>
					<button className="btn btn-sm btn-primary" onClick={onNew}>
						+ New
					</button>
				</div>
			</div>
			<VariationList
				variations={variations}
				selectedId={selectedId}
				actionLoading={actionLoading}
				showTabsSet={showTabsSet}
				onSelect={onSelect}
				onStart={onStart}
				onStop={onStop}
				onDelete={onDelete}
				onPullRequest={onPullRequest}
				onRefresh={onRefresh}
				onToggleTabs={onToggleTabs}
			/>
		</div>
	);
}
