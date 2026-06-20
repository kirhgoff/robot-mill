import type { Variation } from "../api/client";
import { PreviewPanel } from "./PreviewPanel";
import { ChatPanel } from "./ChatPanel";
import { DiffView } from "./DiffView";
import { CompareView } from "./CompareView";
import { TabBar, type Tab } from "./TabBar";
import { EmptyState } from "./ui/EmptyState";

interface Props {
	selected: Variation | null;
	variations: Variation[];
	showTabs: boolean;
	activeTab: Tab;
	onTabChange: (tab: Tab) => void;
}

export function MainPanel({
	selected,
	variations,
	showTabs,
	activeTab,
	onTabChange,
}: Props) {
	return (
		<div className="main-panel">
			{selected ? (
				showTabs ? (
					<>
						<TabBar activeTab={activeTab} onChange={onTabChange} />
						{activeTab === "preview" && <PreviewPanel variation={selected} />}
						{activeTab === "chat" && <ChatPanel variation={selected} />}
						{activeTab === "diff" && <DiffView variationId={selected.id} />}
						{activeTab === "compare" && <CompareView variations={variations} />}
					</>
				) : (
					<PreviewPanel variation={selected} />
				)
			) : (
				<EmptyState
					icon="✦"
					title="Vary"
					subtitle="Select a variation or create a new one"
				/>
			)}
		</div>
	);
}
