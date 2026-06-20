import { useState, useCallback, useEffect } from "react";
import { api, type Variation } from "./api/client";
import { useVariations } from "./hooks/useVariations";
import { CollapsedSidebar } from "./components/CollapsedSidebar";
import { ExpandedSidebar } from "./components/ExpandedSidebar";
import { MainPanel } from "./components/MainPanel";
import { CreateVariationModal } from "./components/CreateVariationModal";
import { SettingsModal } from "./components/SettingsModal";
import type { Tab } from "./components/TabBar";

export function App() {
	const { variations, refresh } = useVariations();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<Tab>("preview");
	const [showCreate, setShowCreate] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [showTabsSet, setShowTabsSet] = useState<Set<string>>(new Set());
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	const selected = variations.find((v) => v.id === selectedId) ?? null;

	// Auto-select the first variation when the list first loads
	useEffect(() => {
		if (selectedId === null && variations.length > 0) {
			setSelectedId(variations[0].id);
		}
	}, [variations, selectedId]);

	// Select a variation and refresh the source repo + variation list so the
	// sidebar / diff stay in sync with whatever has been pushed upstream.
	const handleSelect = useCallback(
		(id: string) => {
			setSelectedId(id);
			api.refreshSource().catch(() => {
				/* non-fatal — refresh is best-effort */
			});
			refresh();
		},
		[refresh],
	);

	const handleAction = useCallback(
		async (
			action: "start" | "stop" | "delete" | "pull-request" | "refresh",
			variation: Variation,
		) => {
			if (action === "delete") {
				if (!window.confirm(`Delete "${variation.title}"? This cannot be undone.`)) return;
			}
			if (action === "pull-request") {
				if (!window.confirm(`Create a pull request for "${variation.title}"?\nThis will push the branch and remove the worktree.`)) return;
			}
			if (action === "refresh") {
				if (
					!window.confirm(
						`Refresh "${variation.title}" from origin?\nThis will hard-reset the worktree and wipe any untracked files.`,
					)
				)
					return;
			}
			setActionLoading(action);
			try {
				switch (action) {
					case "start":
						await api.startServer(variation.id);
						break;
					case "stop":
						await api.stopServer(variation.id);
						break;
					case "delete":
						await api.deleteVariation(variation.id);
						if (selectedId === variation.id) setSelectedId(null);
						break;
					case "pull-request": {
						const result = await api.createPullRequest(variation.id);
						if (selectedId === variation.id) setSelectedId(null);
						if (result.url) window.open(result.url, "_blank");
						break;
					}
					case "refresh":
						await api.refreshVariation(variation.id);
						break;
				}
				refresh();
			} catch (err) {
				alert(err instanceof Error ? err.message : "Action failed");
			} finally {
				setActionLoading(null);
			}
		},
		[selectedId, refresh],
	);

	const handleToggleTabs = useCallback((id: string) => {
		setShowTabsSet((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	return (
		<div className="app-layout">
			{sidebarCollapsed ? (
				<CollapsedSidebar
					selectedTitle={selected?.title}
					onExpand={() => setSidebarCollapsed(false)}
				/>
			) : (
				<ExpandedSidebar
					variations={variations}
					selectedId={selectedId}
					actionLoading={actionLoading}
					showTabsSet={showTabsSet}
					onCollapse={() => setSidebarCollapsed(true)}
					onSettings={() => setShowSettings(true)}
					onNew={() => setShowCreate(true)}
					onSelect={handleSelect}
					onStart={(v) => handleAction("start", v)}
					onStop={(v) => handleAction("stop", v)}
					onDelete={(v) => handleAction("delete", v)}
					onPullRequest={(v) => handleAction("pull-request", v)}
					onRefresh={(v) => handleAction("refresh", v)}
					onToggleTabs={handleToggleTabs}
				/>
			)}
			<MainPanel
				selected={selected}
				variations={variations}
				showTabs={selected ? showTabsSet.has(selected.id) : false}
				activeTab={activeTab}
				onTabChange={setActiveTab}
			/>
			{showCreate && (
				<CreateVariationModal
					onClose={() => setShowCreate(false)}
					onCreated={refresh}
				/>
			)}
			{showSettings && (
				<SettingsModal onClose={() => setShowSettings(false)} />
			)}
		</div>
	);
}
