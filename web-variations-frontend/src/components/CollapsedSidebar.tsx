interface Props {
	selectedTitle?: string;
	onExpand: () => void;
}

export function CollapsedSidebar({ selectedTitle, onExpand }: Props) {
	return (
		<div className="sidebar sidebar-collapsed">
			<button
				className="btn btn-sm sidebar-collapse-btn"
				onClick={onExpand}
				title="Expand sidebar"
			>
				›
			</button>
			{selectedTitle && (
				<span className="sidebar-collapsed-title">{selectedTitle}</span>
			)}
		</div>
	);
}
