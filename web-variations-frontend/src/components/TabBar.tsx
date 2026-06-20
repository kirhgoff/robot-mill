export type Tab = "preview" | "chat" | "diff" | "compare";

const TAB_LABELS: Record<Tab, string> = {
	preview: "🖥 Preview",
	chat: "💬 Chat",
	diff: "📝 Diff",
	compare: "🔍 Compare",
};

interface Props {
	activeTab: Tab;
	onChange: (tab: Tab) => void;
}

export function TabBar({ activeTab, onChange }: Props) {
	return (
		<div className="tab-bar">
			{(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
				<div
					key={tab}
					className={`tab ${activeTab === tab ? "active" : ""}`}
					onClick={() => onChange(tab)}
				>
					{TAB_LABELS[tab]}
				</div>
			))}
		</div>
	);
}
