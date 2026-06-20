import type { Variation } from "../api/client";
import { StatusBadge } from "./StatusBadge";

interface Props {
	variation: Variation;
	isSelected: boolean;
	actionLoading: string | null;
	tabsVisible: boolean;
	onSelect: () => void;
	onStart: () => void;
	onStop: () => void;
	onDelete: () => void;
	onPullRequest: () => void;
	onRefresh: () => void;
	onToggleTabs: () => void;
}

export function VariationCard({
	variation: v,
	isSelected,
	actionLoading,
	tabsVisible,
	onSelect,
	onStart,
	onStop,
	onDelete,
	onPullRequest,
	onRefresh,
	onToggleTabs,
}: Props) {
	const isMain = v.kind === "main";
	return (
		<div
			className={`variation-card ${isSelected ? "active" : ""}`}
			onClick={onSelect}
		>
			<div className="card-info">
				<div className="card-title">{v.title}</div>
				<div className="card-meta">
					<StatusBadge status={v.status} />
					{v.port && <span>:{v.port}</span>}
					{v.baseBranch && <span>← {v.baseBranch}</span>}
					{v.changedFileCount !== undefined && v.changedFileCount > 0 && (
						<span>
							{v.changedFileCount} file{v.changedFileCount !== 1 ? "s" : ""} Δ
						</span>
					)}
				</div>
				{isSelected && v.initialPrompt && (
					<div
						className="card-prompt"
						title={v.initialPrompt}
					>
						<div className="card-prompt-label">Initial prompt</div>
						<div className="card-prompt-body">{v.initialPrompt}</div>
					</div>
				)}
			</div>
			<div className="card-actions" onClick={(e) => e.stopPropagation()}>
				{v.status === "stopped" ? (
					<button
						className="btn btn-sm"
						onClick={onStart}
						disabled={actionLoading !== null}
						title="Start server"
					>
						▶
					</button>
				) : (
					<button
						className="btn btn-sm"
						onClick={onStop}
						disabled={actionLoading !== null || v.status !== "running"}
						title="Stop server"
					>
						⏹
					</button>
				)}
				<button
					className={`btn btn-sm ${tabsVisible ? "btn-active" : ""}`}
					onClick={onToggleTabs}
					title={tabsVisible ? "Hide tabs" : "Show tabs"}
				>
					☰
				</button>
				{isMain ? (
					<button
						className="btn btn-sm"
						onClick={onRefresh}
						disabled={actionLoading !== null}
						title="Refresh from origin (hard reset + clean)"
					>
						🔄
					</button>
				) : (
					<>
						<button
							className="btn btn-sm btn-danger"
							onClick={onDelete}
							disabled={actionLoading !== null}
							title="Delete variation"
						>
							🗑
						</button>
						<button
							className="btn btn-sm"
							onClick={onPullRequest}
							disabled={actionLoading !== null}
							title="Create pull request"
						>
							🔀
						</button>
					</>
				)}
			</div>
		</div>
	);
}
