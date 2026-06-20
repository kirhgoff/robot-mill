interface Props {
	icon?: string;
	title: string;
	subtitle?: string;
	compact?: boolean;
}

export function EmptyState({ icon, title, subtitle, compact }: Props) {
	if (compact) {
		return (
			<div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
				{title}
			</div>
		);
	}
	return (
		<div className="empty-state">
			{icon && <div className="icon">{icon}</div>}
			<div style={{ fontSize: 18, fontWeight: 600 }}>{title}</div>
			{subtitle && (
				<div style={{ fontSize: 12, color: "var(--text-muted)" }}>{subtitle}</div>
			)}
		</div>
	);
}
