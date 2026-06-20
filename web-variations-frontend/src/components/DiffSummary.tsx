interface Summary {
	added: number;
	modified: number;
	deleted: number;
}

interface Props {
	summary: Summary;
}

export function DiffSummary({ summary }: Props) {
	return (
		<div style={{ marginBottom: 12, fontSize: 13, color: "var(--text-secondary)" }}>
			{summary.added} added · {summary.modified} modified · {summary.deleted} deleted
		</div>
	);
}
